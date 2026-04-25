const express = require('express');
const app = express();
const http = require('http').createServer(app);

// 1. ADD CORS TO SOCKET.IO
const io = require('socket.io')(http, {
    cors: {
        origin: "*", // For production, replace "*" with your actual Netlify URL e.g., "https://my-game.netlify.app"
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'Online', players: Object.keys(players).length });
});

// Game State
const players = {};
const PLAYER_RADIUS = 18;
let tagCooldown = 0;

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // If they are the first player in the server, they are "It"
    const isFirstPlayer = Object.keys(players).length === 0;
    
    players[socket.id] = { 
        x: 0, y: 0, 
        vx: 0, vy: 0, 
        isIt: isFirstPlayer 
    };

    // Listen for movement updates from the client
    socket.on('playerMove', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            players[socket.id].vx = data.vx;
            players[socket.id].vy = data.vy;
        }
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        const wasIt = players[socket.id]?.isIt;
        delete players[socket.id];

        // If the player who was "It" leaves, assign "It" to someone else randomly
        const remainingPlayers = Object.keys(players);
        if (wasIt && remainingPlayers.length > 0) {
            const randomPlayer = remainingPlayers[Math.floor(Math.random() * remainingPlayers.length)];
            players[randomPlayer].isIt = true;
            io.emit('newIt', randomPlayer);
        }
    });
});

// Server Tick - 30 times a second
setInterval(() => {
    const now = Date.now();

    // Tag Collision Logic
    if (now > tagCooldown) {
        // Find the player who is currently "It"
        const itId = Object.keys(players).find(id => players[id].isIt);
        
        if (itId) {
            const itPlayer = players[itId];

            for (const otherId in players) {
                if (otherId === itId) continue;

                const p = players[otherId];
                // Calculate distance between "It" and other players
                const dist = Math.hypot(itPlayer.x - p.x, itPlayer.y - p.y);

                // If they touch (radius + radius = 36)
                if (dist < PLAYER_RADIUS * 2) {
                    players[itId].isIt = false;
                    players[otherId].isIt = true;
                    
                    // 2-second immunity cooldown so they don't instantly tag back
                    tagCooldown = now + 2000; 
                    
                    io.emit('playerTagged', otherId);
                    break;
                }
            }
        }
    }

    // Broadcast current state to all clients
    io.emit('gameState', players);
}, 1000 / 30);

http.listen(PORT, () => {
    console.log(`Omicron L04 Server running on port ${PORT}`);
});