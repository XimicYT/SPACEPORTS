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
// --- GLOBAL HELPER FUNCTIONS ---

// 1. Map the doors so the server knows their exact indexes
const doorMap = [];
for (let r = 0; r < MAP_BLUEPRINT.length; r++) {
    for (let c = 0; c < MAP_BLUEPRINT[r].length; c++) {
        if (MAP_BLUEPRINT[r][c] === 'D') doorMap.push({ r, c });
    }
}
const getDoorIndex = (r, c) => doorMap.findIndex(d => d.r === r && d.c === c);

// 2. Global Perfect Circle-to-Box Collision
const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

const resolveWallCollision = (entity, radius, wallX, wallY, wallW, wallH) => {
    let closestX = clamp(entity.x, wallX, wallX + wallW);
    let closestY = clamp(entity.y, wallY, wallY + wallH);

    let dx = entity.x - closestX;
    let dy = entity.y - closestY;
    let distanceSquared = (dx * dx) + (dy * dy);

    if (distanceSquared < (radius * radius) && distanceSquared > 0) {
        let distance = Math.sqrt(distanceSquared);
        let overlap = radius - distance;
        
        // Eject entity mathematically
        entity.x += (dx / distance) * overlap;
        entity.y += (dy / distance) * overlap;
        
        // Reflect velocity based on which side was hit
        if (closestX === wallX || closestX === wallX + wallW) entity.vx *= BOUNCE;
        if (closestY === wallY || closestY === wallY + wallH) entity.vy *= BOUNCE;
    }
};

// Initialize Balls
const balls = [
    { id: 'b1', x: 750, y: 450, vx: 0, vy: 0, radius: BALL_RADIUS },
    { id: 'b2', x: 1950, y: 3450, vx: 0, vy: 0, radius: BALL_RADIUS },
    { id: 'b3', x: 9150, y: 5850, vx: 0, vy: 0, radius: BALL_RADIUS }
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

    // Replace socket.on('playerMove') in server.js
socket.on('playerInput', (data) => {
    if (!socket.sessionId || !players[socket.sessionId]) return;
    const p = players[socket.sessionId];
    
    // Accept input intent, not absolute position
    p.inputX = data.dx; // -1, 0, or 1
    p.inputY = data.dy; // -1, 0, or 1
    p.sequence = data.sequence; // Tracking for reconciliation
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
let lastTick = Date.now();

setInterval(() => {
    const now = Date.now();
    const dt = (now - lastTick) / 1000; // Calculate delta time in seconds
    lastTick = now;
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
    // 1.5 SERVER-AUTHORITATIVE PLAYER PHYSICS & COLLISIONS
    for (const id in players) {
        let p = players[id];
        let accel = 1200; // Matches frontend player.accel
        
        // A. Apply input to velocity
        if (p.inputX) p.vx += p.inputX * accel * dt;
        if (p.inputY) p.vy += p.inputY * accel * dt;
        
        // B. Friction/Drift decay (Matches frontend player.friction = 0.985)
        p.vx *= Math.pow(0.985, dt * 60);
        p.vy *= Math.pow(0.985, dt * 60);
        
        // C. Apply velocity to position
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        // D. Server-Side Wall Collisions for Players
        const pGridX = Math.floor(p.x / TILE_SIZE);
        const pGridY = Math.floor(p.y / TILE_SIZE);
        
        let pStartR = Math.max(0, pGridY - 1); let pEndR = Math.min(MAP_BLUEPRINT.length - 1, pGridY + 1);
        let pStartC = Math.max(0, pGridX - 1); let pEndC = Math.min(MAP_BLUEPRINT[0].length - 1, pGridX + 1);

        for (let r = pStartR; r <= pEndR; r++) {
            for (let c = pStartC; c <= pEndC; c++) {
                const t = MAP_BLUEPRINT[r][c];
                if (t === '1') {
                    resolveWallCollision(p, PLAYER_RADIUS, c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE);
                } else if (t === 'D') {
                    let doorIndex = getDoorIndex(r, c);
                    if (doorIndex !== -1 && activeDoors[doorIndex]) {
                        resolveWallCollision(p, PLAYER_RADIUS, c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE);
                    }
                }
            }
        }
    }
// 2. BALL PHYSICS
    balls.forEach(ball => {
        // Friction adjusted for dt (60 frames per second standard)
        ball.vx *= Math.pow(FRICTION, dt * 60);
        ball.vy *= Math.pow(FRICTION, dt * 60);

        // --- PLAYER VS BALL COLLISIONS (Lag-Resistant Billiard Physics) ---
        for (const pid in players) {
            const p = players[pid];
            const dx = ball.x - p.x;
            const dy = ball.y - p.y;
            const dist = Math.hypot(dx, dy);
            
            // Add a tiny buffer (+2) to catch high-speed impacts between server ticks
            const minDist = ball.radius + PLAYER_RADIUS + 2; 

            if (dist < minDist && dist > 0) {
                const overlap = minDist - dist;
                const nx = dx / dist;
                const ny = dy / dist;
                
                // Displace ball strictly out of the player to prevent physics sticking
                ball.x += nx * overlap;
                ball.y += ny * overlap;
                
                // FIXED: Convert player velocity from units/second to units/frame!
                const pVxFrame = p.vx / 60;
                const pVyFrame = p.vy / 60;

                // Calculate relative velocity so we only push the ball if we are moving FASTER than it
                const relV = ((pVxFrame - ball.vx) * nx) + ((pVyFrame - ball.vy) * ny);
                
                if (relV > 0) {
                    // Ball takes the hit! 1.2 simulates the ball being lighter than the player's engines
                    ball.vx += nx * relV * 1.2; 
                    ball.vy += ny * relV * 1.2;
                }
            }
        }

        // --- BALL VS BALL COLLISIONS (Fixed Momentum Transfer) ---
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

                // Safely exchange momentum only if moving towards each other
                const relV = ((ball.vx - otherBall.vx) * nx) + ((ball.vy - otherBall.vy) * ny);
                if (relV > 0) {
                    ball.vx -= nx * relV * 0.5;
                    ball.vy -= ny * relV * 0.5;
                    otherBall.vx += nx * relV * 0.5;
                    otherBall.vy += ny * relV * 0.5;
                }
            }
        });

        // SAFETY NET: Hard cap the ball's speed so it can never tunnel through walls again
        ball.vx = Math.max(-100, Math.min(100, ball.vx));
        ball.vy = Math.max(-100, Math.min(100, ball.vy));

        // Apply velocity to position based on dt
        ball.x += ball.vx * (dt * 60); 
        ball.y += ball.vy * (dt * 60);

        // --- TILE INTERACTIONS (Walls, Doors, Speed Pads) ---
        const gridX = Math.floor(ball.x / TILE_SIZE);
        const gridY = Math.floor(ball.y / TILE_SIZE);

        if (gridY >= 0 && gridY < MAP_BLUEPRINT.length && gridX >= 0 && gridX < MAP_BLUEPRINT[0].length) {
            const tile = MAP_BLUEPRINT[gridY][gridX];

            // Speed Pads
            const speedForce = 0.8;
            if (tile === '>') ball.vx += speedForce;
            if (tile === '<') ball.vx -= speedForce;
            if (tile === '^') ball.vy -= speedForce;
            if (tile === 'v') ball.vy += speedForce;

            // Check surrounding 9 tiles for the ball
            let startR = Math.max(0, gridY - 1); let endR = Math.min(MAP_BLUEPRINT.length - 1, gridY + 1);
            let startC = Math.max(0, gridX - 1); let endC = Math.min(MAP_BLUEPRINT[0].length - 1, gridX + 1);

            for (let r = startR; r <= endR; r++) {
                for (let c = startC; c <= endC; c++) {
                    const t = MAP_BLUEPRINT[r][c];
                    if (t === '1') {
                        // Uses the GLOBAL function we just added at the top
                        resolveWallCollision(ball, ball.radius, c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE);
                    } else if (t === 'D') {
                        let doorIndex = getDoorIndex(r, c);
                        if (doorIndex !== -1 && activeDoors[doorIndex]) {
                            resolveWallCollision(ball, ball.radius, c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE);
                        }
                    }
                }
            }
        }
    });

    // 3. EMIT GAME STATE (Now includes balls!)
    io.emit('gameState', { players, doors: activeDoors, balls });
}, 1000 / 60);
http.listen(PORT, () => {
    console.log(`Omicron L04 Server running on port ${PORT}`);
});