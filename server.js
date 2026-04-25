const express = require('express');
const app = express();
const http = require('http').createServer(app);

// FORCE WEBSOCKETS ONLY for maximum speed and lowest latency
const io = require('socket.io')(http, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket'] 
});

const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'Online', activeSessions: Object.keys(players).length });
});

// Game State
const players = {}; 
const disconnectTimeouts = {}; 
const PLAYER_RADIUS = 18;
let tagCooldown = 0;

io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on('initSession', (sessionId) => {
        socket.sessionId = sessionId; 

        if (disconnectTimeouts[sessionId]) {
            clearTimeout(disconnectTimeouts[sessionId]);
            delete disconnectTimeouts[sessionId];
            console.log(`Session reconnected: ${sessionId}`);
        } else if (!players[sessionId]) {
            console.log(`New session created: ${sessionId}`);
            const isFirstPlayer = Object.keys(players).length === 0;
            players[sessionId] = { 
                x: 0, y: 0, vx: 0, vy: 0, 
                isIt: isFirstPlayer,
                lastHeartbeat: Date.now(),
                stunnedUntil: 0
            };
        }
        socket.emit('gameState', players);
    });

    // Client actively pings this to prove they are still alive
    socket.on('heartbeat', () => {
        if (socket.sessionId && players[socket.sessionId]) {
            players[socket.sessionId].lastHeartbeat = Date.now();
        }
    });

    socket.on('playerMove', (data) => {
        if (!socket.sessionId || !players[socket.sessionId]) return;
        players[socket.sessionId].x = data.x;
        players[socket.sessionId].y = data.y;
        players[socket.sessionId].vx = data.vx;
        players[socket.sessionId].vy = data.vy;
    });

    socket.on('disconnect', () => {
        const sessionId = socket.sessionId;
        if (!sessionId || !players[sessionId]) return;

        // Grace period for accidental refreshes
        disconnectTimeouts[sessionId] = setTimeout(() => {
            removePlayer(sessionId);
        }, 10000); 
    });
});

// Helper function to safely delete a player and reassign "It"
function removePlayer(sessionId) {
    if (!players[sessionId]) return;
    console.log(`Session expired and removed: ${sessionId}`);
    const wasIt = players[sessionId].isIt;
    delete players[sessionId];
    delete disconnectTimeouts[sessionId];

    const remainingPlayers = Object.keys(players);
    if (wasIt && remainingPlayers.length > 0) {
        const randomPlayer = remainingPlayers[Math.floor(Math.random() * remainingPlayers.length)];
        players[randomPlayer].isIt = true;
        io.emit('newIt', randomPlayer);
    }
}

// ZOMBIE GARBAGE COLLECTION (Runs every 5 seconds)
setInterval(() => {
    const now = Date.now();
    for (const sessionId in players) {
        // If we haven't heard from them in 15 seconds, execute them
        if (now - players[sessionId].lastHeartbeat > 15000) {
            removePlayer(sessionId);
        }
    }
}, 5000);

// SERVER TICK - UPGRADED TO 60 FPS FOR SMOOTHNESS
setInterval(() => {
    const now = Date.now();

    if (now > tagCooldown) {
        const itId = Object.keys(players).find(id => players[id].isIt);
        
        // STUN FIX: Check that the 'It' player exists AND their stun timer has expired
        if (itId && players[itId].stunnedUntil <= now) {
            const itPlayer = players[itId];

            for (const otherId in players) {
                if (otherId === itId) continue;

                const p = players[otherId];
                const dist = Math.hypot(itPlayer.x - p.x, itPlayer.y - p.y);

                if (dist < PLAYER_RADIUS * 2) {
                    players[itId].isIt = false;
                    players[otherId].isIt = true;
                    
                    // Stun the newly tagged player for 2.5 seconds
                    players[otherId].stunnedUntil = now + 2500;
                    
                    // Give the person who tagged them 3.5 seconds of immunity to run away
                    tagCooldown = now + 3500; 
                    io.emit('playerTagged', otherId);
                    break;
                }
            }
        }
    }

    io.emit('gameState', players);
}, 1000 / 60);

http.listen(PORT, () => {
    console.log(`Omicron L04 Server running on port ${PORT}`);
});