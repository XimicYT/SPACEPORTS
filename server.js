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

// DOOR STATE: 8 doors total.
const MAX_DOORS = 8;
const MAX_CLOSED_DOORS = 3;
const doors = Array(MAX_DOORS).fill(null).map(() => ({
    closeUntil: 0,
    cooldownUntil: 0
})); 

// --- PHYSICS & MAP CONSTANTS ---
const TILE_SIZE = 300; 
// "A little more than about half the width of a hallway"
const BALL_RADIUS = (TILE_SIZE / 4) + 10; 
const FRICTION = 0.96; 
const BOUNCE = -0.7; // How bouncy the walls are

const MAP_BLUEPRINT = [
    '111111111111111111111111111111111111111111111',
    '10000>>>>>000D0000000000000000D00000<<<<<0001',
    '101111111111011111111111111111111101111111101',
    '100000000000000000000000000000000000000000001',
    '10101111111111111111111110111111111111^110101',
    '101011000S0000001000000D000000011100100010101',
    '101011011111110110111111111011011100100010101',
    '1^101000>>>>>000001000010000100<<<001000101v1',
    '1^10101111111111011011011011110111101^0v101v1',
    '1^10101000D00001000010010011000011100000101v1',
    '1010101011111101011111011111110111001>>>10101',
    '1010100011111100011111000001100001001^0v10101',
    '10101^1011111101000000011010101101v01<<<10101',
    '10101^1000000001011011011110100001v0100010001',
    '101000111111010111v<<101111011101100100010101',
    '101010000>>0010000>>^100000D0000000010^v>0101',
    '101010111111110111>^<111111111111111100010101',
    '1^10100000<<0000010001000000000000000000101^1',
    '1^10111111111101110101011111111111101000101^1',
    '1^10100000D00000000000000000000000001>^<101^1',
    '101011111011111111111111111111111111100010101',
    '101000000000000000000000000000000000000000101',
    '101111111111111101111111111111111111111111101',
    '10000<<<<<000D0000000000000000D00000>>>>>0001',
    '111111111111111111111111111111111111111111111',
];

// Initialize Balls
// Initialize Balls
const balls = [
    { id: 'b1', x: 750, y: 450, vx: 0, vy: 0, radius: BALL_RADIUS, startX: 750, startY: 450, padTime: 0 },
    { id: 'b2', x: 1950, y: 3450, vx: 0, vy: 0, radius: BALL_RADIUS, startX: 1950, startY: 3450, padTime: 0 },
    { id: 'b3', x: 9150, y: 5850, vx: 0, vy: 0, radius: BALL_RADIUS, startX: 9150, startY: 5850, padTime: 0 }
];

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
        const now = Date.now();
        const activeDoors = doors.map(d => d.closeUntil > now);
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

    // --- INSTANT BALL STRIKE LISTENER ---
    // --- INSTANT BALL STRIKE LISTENER ---
    socket.on('ballStrike', (data) => {
        // FIXED: We must look up the player using socket.sessionId, not socket.id!
        const p = players[socket.sessionId];
        const ball = balls[data.ballId]; 
        
        if (!p || !ball) return;

        // Anti-Cheat / Lag Compensation Check: Ensure the player is actually near the ball
        const dist = Math.hypot(ball.x - p.x, ball.y - p.y);
        const maxValidDistance = ball.radius + PLAYER_RADIUS + 150; // 150px leeway for latency

        if (dist < maxValidDistance) {
            // NEW: Increased the weight modifier from 0.8 to 1.6
            // This makes the ball "lighter", taking much more momentum from your strikes.
            const impulse = (data.impactSpeed / 60) * 1.6; 
            
            ball.vx -= data.nx * impulse;
            ball.vy -= data.ny * impulse;
        }
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
    
    // FIXED: Compare against the closeUntil property, not the object itself
    let closedCount = doors.filter(d => d.closeUntil > now).length;
    
    // Randomly close a door if we are under the max limit of 3
    if (closedCount < MAX_CLOSED_DOORS && Math.random() < 0.6) {
        let openIndices = [];
        for (let i = 0; i < doors.length; i++) {
            // FIXED: Check both closeUntil and cooldown properties
            if (doors[i].closeUntil <= now && doors[i].cooldownUntil <= now) {
                openIndices.push(i);
            }
        }
        
        if (openIndices.length > 0) {
            let pick = openIndices[Math.floor(Math.random() * openIndices.length)];
            
            // FIXED: Update the object property, do not overwrite the whole object
            doors[pick].closeUntil = now + 2000 + Math.random() * 2000;
            doors[pick].cooldownUntil = doors[pick].closeUntil + 1500; // Gives players a 1.5s window before it can close again
        }
    }
}, 1000);

// SERVER TICK - 60 FPS
setInterval(() => {
    const now = Date.now();
    const activeDoors = doors.map(d => d.closeUntil > now);
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
// 2. BALL PHYSICS
    balls.forEach(ball => {
        // Apply Friction
        ball.vx *= FRICTION;
        ball.vy *= FRICTION;

        // --- BALL VS BALL COLLISIONS ---
        balls.forEach(otherBall => {
            if (ball.id === otherBall.id) return;
            const dx = otherBall.x - ball.x;
            const dy = otherBall.y - ball.y;
            const dist = Math.hypot(dx, dy);
            const minDist = ball.radius + otherBall.radius;

            if (dist < minDist && dist > 0) {
                const overlap = minDist - dist;
                const nx = dx / dist;
                const ny = dy / dist;

                // Push them apart equally
                ball.x -= nx * (overlap / 2);
                ball.y -= ny * (overlap / 2);
                otherBall.x += nx * (overlap / 2);
                otherBall.y += ny * (overlap / 2);

                // Exchange momentum (Elastic bounce)
                const kx = (ball.vx - otherBall.vx);
                const ky = (ball.vy - otherBall.vy);
                const p = (nx * kx + ny * ky); 
                
                ball.vx -= p * nx;
                ball.vy -= p * ny;
                otherBall.vx += p * nx;
                otherBall.vy += p * ny;
            }
        });

        // Apply Velocity to Position
        ball.x += ball.vx;
        ball.y += ball.vy;

        // --- TILE INTERACTIONS (Walls, Doors, Speed Pads) ---
        // Get the grid coordinates of the ball's center
        const gridX = Math.floor(ball.x / TILE_SIZE);
        const gridY = Math.floor(ball.y / TILE_SIZE);

        if (gridY >= 0 && gridY < MAP_BLUEPRINT.length && gridX >= 0 && gridX < MAP_BLUEPRINT[0].length) {
            const tile = MAP_BLUEPRINT[gridY][gridX];

           // Speed Pads & Anti-Vortex Respawn Logic
            const speedForce = 0.8;
            let onPad = false;

            if (tile === '>') { ball.vx += speedForce; onPad = true; }
            if (tile === '<') { ball.vx -= speedForce; onPad = true; }
            if (tile === '^') { ball.vy -= speedForce; onPad = true; }
            if (tile === 'v') { ball.vy += speedForce; onPad = true; }

            if (onPad) {
                // Add ~16.6ms (one frame at 60fps) to the timer
                ball.padTime += (1000 / 60); 
                
                // If it's been on a pad for more than 15 seconds (15000 ms), RESPAWN IT
                if (ball.padTime >= 15000) {
                    ball.x = ball.startX;
                    ball.y = ball.startY;
                    ball.vx = 0;
                    ball.vy = 0;
                    ball.padTime = 0;
                }
            } else {
                // Reset the timer instantly if it touches a normal floor/wall
                ball.padTime = 0; 
            }

            // Simple Wall/Door Bouncing
            // (Checks the edges of the ball against tile boundaries)
            const checkWall = (gx, gy) => {
                if (gy < 0 || gy >= MAP_BLUEPRINT.length || gx < 0 || gx >= MAP_BLUEPRINT[0].length) return true;
                const t = MAP_BLUEPRINT[gy][gx];
                
                // It's a wall, OR it's a door and the door is currently active (closed)
                if (t === '1') return true;
                if (t === 'D') {
                    // Find which door index this is to check its state
                    let doorIndex = 0;
                    for(let i=0; i<MAP_BLUEPRINT.length; i++) {
                        for(let j=0; j<MAP_BLUEPRINT[i].length; j++) {
                            if (MAP_BLUEPRINT[i][j] === 'D') {
                                if (i === gy && j === gx) {
                                    return activeDoors[doorIndex];
                                }
                                doorIndex++;
                            }
                        }
                    }
                }
                return false;
            };

            // Bounce X
            if (ball.vx > 0 && checkWall(Math.floor((ball.x + ball.radius) / TILE_SIZE), gridY)) {
                ball.x = (Math.floor((ball.x + ball.radius) / TILE_SIZE) * TILE_SIZE) - ball.radius - 1;
                ball.vx *= BOUNCE;
            } else if (ball.vx < 0 && checkWall(Math.floor((ball.x - ball.radius) / TILE_SIZE), gridY)) {
                ball.x = (Math.floor(ball.x / TILE_SIZE) * TILE_SIZE) + ball.radius + 1;
                ball.vx *= BOUNCE;
            }

            // Bounce Y
            if (ball.vy > 0 && checkWall(gridX, Math.floor((ball.y + ball.radius) / TILE_SIZE))) {
                ball.y = (Math.floor((ball.y + ball.radius) / TILE_SIZE) * TILE_SIZE) - ball.radius - 1;
                ball.vy *= BOUNCE;
            } else if (ball.vy < 0 && checkWall(gridX, Math.floor((ball.y - ball.radius) / TILE_SIZE))) {
                ball.y = (Math.floor(ball.y / TILE_SIZE) * TILE_SIZE) + ball.radius + 1;
                ball.vy *= BOUNCE;
            }
        }
    });

    // 3. EMIT GAME STATE (Now includes balls!)
    io.emit('gameState', { players, doors: activeDoors, balls });
}, 1000 / 60);
http.listen(PORT, () => {
    console.log(`Omicron L04 Server running on port ${PORT}`);
});