{\rtf1\ansi\ansicpg1252\cocoartf2759
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 const WebSocket = require('ws');\
const http = require('http');\
const path = require('path');\
const fs = require('fs');\
const cors = require('cors');\
\
// Create HTTP server for serving static files\
const server = http.createServer(cors(), (req, res) => \{\
  // Add CORS headers\
  res.setHeader('Access-Control-Allow-Origin', '*');\
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');\
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');\
  \
  if (req.method === 'OPTIONS') \{\
    res.writeHead(200);\
    res.end();\
    return;\
  \}\
  \
  // Health check endpoint for Render\
  if (req.url === '/health') \{\
    res.writeHead(200, \{ 'Content-Type': 'application/json' \});\
    res.end(JSON.stringify(\{ status: 'ok', timestamp: new Date().toISOString() \}));\
    return;\
  \}\
  \
  // Simple static file serving for development\
  let filePath = path.join(__dirname, 'dist', req.url === '/' ? 'index.html' : req.url);\
  \
  if (fs.existsSync(filePath)) \{\
    const ext = path.extname(filePath);\
    const contentType = \{\
      '.html': 'text/html',\
      '.js': 'text/javascript',\
      '.css': 'text/css',\
      '.json': 'application/json'\
    \}[ext] || 'text/plain';\
    \
    res.writeHead(200, \{ 'Content-Type': contentType \});\
    fs.createReadStream(filePath).pipe(res);\
  \} else \{\
    res.writeHead(404);\
    res.end('Not found');\
  \}\
\});\
\
// Create WebSocket server\
const wss = new WebSocket.Server(\{ server \});\
\
// Game state\
let gameState = \{\
  participants: [],\
  totalPot: 0,\
  timeRemaining: 0,\
  isActive: false,\
  winner: null,\
  gameStartTime: null\
\};\
\
let gameTimer = null;\
\
// Broadcast to all connected clients\
function broadcast(data) \{\
  wss.clients.forEach(client => \{\
    if (client.readyState === WebSocket.OPEN) \{\
      client.send(JSON.stringify(data));\
    \}\
  \});\
\}\
\
// Calculate win chances\
function calculateWinChances() \{\
  gameState.participants = gameState.participants.map(participant => (\{\
    ...participant,\
    winChance: gameState.totalPot > 0 ? (participant.amount / gameState.totalPot) * 100 : 0\
  \}));\
\}\
\
// Start game timer\
function startGameTimer() \{\
  if (gameTimer) return; // Timer already running\
  \
  gameState.gameStartTime = Date.now();\
  gameState.isActive = true;\
  gameState.timeRemaining = 60000; // 60 seconds\
  \
  gameTimer = setInterval(() => \{\
    const elapsed = Date.now() - gameState.gameStartTime;\
    gameState.timeRemaining = Math.max(60000 - elapsed, 0);\
    \
    broadcast(\{\
      type: 'gameUpdate',\
      gameState\
    \});\
    \
    if (gameState.timeRemaining === 0) \{\
      selectWinner();\
    \}\
  \}, 100);\
\}\
\
// Select winner\
function selectWinner() \{\
  if (gameState.participants.length === 0) return;\
  \
  const random = Math.random() * gameState.totalPot;\
  let accumulated = 0;\
  let winner = gameState.participants[0];\
  \
  for (const participant of gameState.participants) \{\
    accumulated += participant.amount;\
    if (random <= accumulated) \{\
      winner = participant;\
      break;\
    \}\
  \}\
  \
  gameState.winner = winner.publicKey;\
  gameState.isActive = false;\
  gameState.timeRemaining = 0;\
  \
  if (gameTimer) \{\
    clearInterval(gameTimer);\
    gameTimer = null;\
  \}\
  \
  broadcast(\{\
    type: 'gameUpdate',\
    gameState\
  \});\
  \
  console.log('Winner selected:', winner.publicKey, 'Amount won:', gameState.totalPot);\
\}\
\
// Reset game\
function resetGame() \{\
  if (gameTimer) \{\
    clearInterval(gameTimer);\
    gameTimer = null;\
  \}\
  \
  gameState = \{\
    participants: [],\
    totalPot: 0,\
    timeRemaining: 0,\
    isActive: false,\
    winner: null,\
    gameStartTime: null\
  \};\
  \
  broadcast(\{\
    type: 'gameUpdate',\
    gameState\
  \});\
\}\
\
// Handle WebSocket connections\
wss.on('connection', (ws) => \{\
  console.log('New client connected');\
  \
  // Send current game state to new client\
  ws.send(JSON.stringify(\{\
    type: 'gameUpdate',\
    gameState\
  \}));\
  \
  ws.on('message', (message) => \{\
    try \{\
      const data = JSON.parse(message);\
      \
      switch (data.type) \{\
        case 'placeBet':\
          const \{ publicKey, amount \} = data;\
          \
          // Check if game has ended\
          if (gameState.timeRemaining === 0 && gameState.participants.length > 0) \{\
            ws.send(JSON.stringify(\{\
              type: 'error',\
              message: 'Lottery has ended. Wait for the next round!'\
            \}));\
            return;\
          \}\
          \
          // Add participant\
          gameState.participants.push(\{\
            publicKey,\
            amount,\
            winChance: 0,\
            timestamp: Date.now()\
          \});\
          \
          gameState.totalPot += amount;\
          calculateWinChances();\
          \
          // Start timer if this is the first participant\
          if (gameState.participants.length === 1) \{\
            startGameTimer();\
          \}\
          \
          broadcast(\{\
            type: 'gameUpdate',\
            gameState\
          \});\
          \
          ws.send(JSON.stringify(\{\
            type: 'betPlaced',\
            message: `Bet of $\{amount\} SOL placed successfully!`\
          \}));\
          \
          break;\
          \
        case 'resetGame':\
          resetGame();\
          break;\
          \
        default:\
          console.log('Unknown message type:', data.type);\
      \}\
    \} catch (error) \{\
      console.error('Error processing message:', error);\
      ws.send(JSON.stringify(\{\
        type: 'error',\
        message: 'Invalid message format'\
      \}));\
    \}\
  \});\
  \
  ws.on('close', () => \{\
    console.log('Client disconnected');\
  \});\
\});\
\
const PORT = process.env.PORT || 3001;\
server.listen(PORT, () => \{\
  console.log(`WebSocket server running on port $\{PORT\}`);\
  console.log(`Environment: $\{process.env.NODE_ENV || 'development'\}`);\
\});}