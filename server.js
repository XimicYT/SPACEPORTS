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

// DOOR STATE: 8 doors total. Values store the timestamp of when they will open.
const MAX_DOORS = 8;
const MAX_CLOSED_DOORS = 3;
const doors = Array(MAX_DOORS).fill(0); 

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
        
        // Send initial state
        const activeDoors = doors.map(d => d > Date.now());
        socket.emit('gameState', { players, doors: activeDoors });
    });

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

        disconnectTimeouts[sessionId] = setTimeout(() => {
            removePlayer(sessionId);
        }, 10000); 
    });
});

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

// ZOMBIE GARBAGE COLLECTION
setInterval(() => {
    const now = Date.now();
    for (const sessionId in players) {
        if (now - players[sessionId].lastHeartbeat > 15000) {
            removePlayer(sessionId);
        }
    }
}, 5000);

// DOOR CONTROLLER (Runs every second)
setInterval(() => {
    const now = Date.now();
    let closedCount = doors.filter(d => d > now).length;
    
    // Randomly close a door if we are under the max limit of 3
    if (closedCount < MAX_CLOSED_DOORS && Math.random() < 0.6) {
        let openIndices = [];
        for (let i = 0; i < doors.length; i++) {
            if (doors[i] <= now) openIndices.push(i);
        }
        
        if (openIndices.length > 0) {
            let pick = openIndices[Math.floor(Math.random() * openIndices.length)];
            // Close for a random time between 2 and 4 seconds
            doors[pick] = now + 2000 + Math.random() * 2000;
        }
    }
}, 1000);

// SERVER TICK - 60 FPS
setInterval(() => {
    const now = Date.now();

    if (now > tagCooldown) {
        const itId = Object.keys(players).find(id => players[id].isIt);
        
        if (itId && players[itId].stunnedUntil <= now) {
            const itPlayer = players[itId];

            for (const otherId in players) {
                if (otherId === itId) continue;

                const p = players[otherId];
                const dist = Math.hypot(itPlayer.x - p.x, itPlayer.y - p.y);

                if (dist < PLAYER_RADIUS * 2) {
                    players[itId].isIt = false;
                    players[otherId].isIt = true;
                    players[otherId].stunnedUntil = now + 2500;
                    tagCooldown = now + 3500; 
                    io.emit('playerTagged', otherId);
                    break;
                }
            }
        }
    }

    const activeDoors = doors.map(d => d > now);
    io.emit('gameState', { players, doors: activeDoors });
}, 1000 / 60);

http.listen(PORT, () => {
    console.log(`Omicron L04 Server running on port ${PORT}`);
});