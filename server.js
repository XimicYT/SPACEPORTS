const express = require('express');
const app = express();
const http = require('http').createServer(app);

const io = require('socket.io')(http, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'Online', activeSessions: Object.keys(players).length });
});

// Game State
const players = {}; 
const disconnectTimeouts = {}; // Tracks grace periods for dropped connections
const PLAYER_RADIUS = 18;
let tagCooldown = 0;

io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Client authenticates with a session ID instead of relying on Socket ID
    socket.on('initSession', (sessionId) => {
        socket.sessionId = sessionId; // Bind this socket to the session

        // If they are reconnecting within the grace period, cancel their deletion
        if (disconnectTimeouts[sessionId]) {
            clearTimeout(disconnectTimeouts[sessionId]);
            delete disconnectTimeouts[sessionId];
            console.log(`Session reconnected: ${sessionId}`);
        } 
        // If it's a brand new session, initialize their player object
        else if (!players[sessionId]) {
            console.log(`New session created: ${sessionId}`);
            const isFirstPlayer = Object.keys(players).length === 0;
            players[sessionId] = { 
                x: 0, y: 0, 
                vx: 0, vy: 0, 
                isIt: isFirstPlayer 
            };
        }

        // Send them the current state immediately so they can sync
        socket.emit('gameState', players);
    });

    socket.on('playerMove', (data) => {
        if (!socket.sessionId || !players[socket.sessionId]) return;
        
        // Update their specific session data
        players[socket.sessionId].x = data.x;
        players[socket.sessionId].y = data.y;
        players[socket.sessionId].vx = data.vx;
        players[socket.sessionId].vy = data.vy;
    });

    socket.on('disconnect', () => {
        console.log(`Socket disconnected: ${socket.id}`);
        const sessionId = socket.sessionId;
        
        if (!sessionId || !players[sessionId]) return;

        // Don't delete them immediately. Give them 10 seconds to refresh or reconnect.
        disconnectTimeouts[sessionId] = setTimeout(() => {
            console.log(`Session expired and removed: ${sessionId}`);
            const wasIt = players[sessionId].isIt;
            delete players[sessionId];
            delete disconnectTimeouts[sessionId];

            // Reassign "It" if the player who left was "It"
            const remainingPlayers = Object.keys(players);
            if (wasIt && remainingPlayers.length > 0) {
                const randomPlayer = remainingPlayers[Math.floor(Math.random() * remainingPlayers.length)];
                players[randomPlayer].isIt = true;
                io.emit('newIt', randomPlayer);
            }
        }, 10000); // 10-second grace period
    });
});

// Server Tick - 30 times a second
setInterval(() => {
    const now = Date.now();

    if (now > tagCooldown) {
        const itId = Object.keys(players).find(id => players[id].isIt);
        
        if (itId) {
            const itPlayer = players[itId];

            for (const otherId in players) {
                if (otherId === itId) continue;

                const p = players[otherId];
                const dist = Math.hypot(itPlayer.x - p.x, itPlayer.y - p.y);

                if (dist < PLAYER_RADIUS * 2) {
                    players[itId].isIt = false;
                    players[otherId].isIt = true;
                    tagCooldown = now + 2000; 
                    io.emit('playerTagged', otherId);
                    break;
                }
            }
        }
    }

    io.emit('gameState', players);
}, 1000 / 30);

http.listen(PORT, () => {
    console.log(`Omicron L04 Server running on port ${PORT}`);
});