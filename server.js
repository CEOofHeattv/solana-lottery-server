const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

// Create HTTP server for serving static files
const server = http.createServer(cors(), (req, res) => {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Health check endpoint for Render
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }
  
  // Simple static file serving for development
  let filePath = path.join(__dirname, 'dist', req.url === '/' ? 'index.html' : req.url);
  
  if (fs.existsSync(filePath)) {
    const ext = path.extname(filePath);
    const contentType = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json'
    }[ext] || 'text/plain';
    
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Import Solana dependencies
const { Keypair, Connection, clusterApiUrl, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');

// Platform fee configuration
const PLATFORM_FEE_WALLET = '4wRPiXKntN8qyMqZnT2NfsBcE8fhhnGWoygBmM857BdV';
const PLATFORM_FEE_PERCENTAGE = 0.025; // 2.5%

// Game state
let gameState = {
  lotteryWallet: null, // Keypair - smart contract wallet for current game
  lotteryWalletAddress: null, // Public key string
  participants: [],
  totalPot: 0,
  timeRemaining: 0,
  isActive: false,
  winner: null,
  gameStartTime: null,
  winnerPayoutSignature: null,
  gamePhase: 'waiting' // 'waiting', 'active', 'ended', 'resetting'
};

let gameTimer = null;
let connection = null;

// Initialize Solana connection
try {
  connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
  console.log('Connected to Solana devnet');
} catch (error) {
  console.error('Failed to connect to Solana:', error);
}

// Broadcast to all connected clients
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Create lottery wallet once (reuse same wallet)
function createNewLotteryWallet() {
  const lotteryWallet = Keypair.generate();
  gameState.lotteryWallet = lotteryWallet;
  gameState.lotteryWalletAddress = lotteryWallet.publicKey.toString();
  
  console.log('=== NEW LOTTERY WALLET CREATED ===');
  console.log('Address:', gameState.lotteryWalletAddress);
  
  return lotteryWallet;
}

function createGameWallet() {
  // Always create a new wallet for each game
  const lotteryWallet = Keypair.generate();
  gameState.lotteryWallet = lotteryWallet;
  gameState.lotteryWalletAddress = lotteryWallet.publicKey.toString();
  gameState.gamePhase = 'waiting';
  
  console.log('=== NEW SMART CONTRACT WALLET CREATED ===');
  console.log('Address:', gameState.lotteryWalletAddress);
  console.log('Phase: Waiting for first bet');
  
  // Broadcast new wallet to all clients
  broadcast({
    type: 'gameUpdate',
    gameState: {
      lotteryWallet: gameState.lotteryWalletAddress,
      participants: gameState.participants,
      totalPot: gameState.totalPot,
      timeRemaining: gameState.timeRemaining,
      isActive: gameState.isActive,
      winner: gameState.winner,
      winnerPayoutSignature: gameState.winnerPayoutSignature,
      gamePhase: gameState.gamePhase
    }
  });
  
  return lotteryWallet;
}

function ensureGameWallet() {
  if (!gameState.lotteryWallet) {
    return createGameWallet();
  }
  return gameState.lotteryWallet;
}

// Verify transaction to lottery wallet
async function verifyTransaction(signature, expectedAmount, senderPublicKey) {
  if (!connection || !gameState.lotteryWallet) return false;

  try {
    const transaction = await connection.getTransaction(signature, {
      commitment: 'confirmed'
    });

    if (!transaction || !transaction.meta || transaction.meta.err) {
      return false;
    }

    // Verify sender and receiver
    const accounts = transaction.transaction.message.accountKeys;
    const instruction = transaction.transaction.message.instructions[0];
    
    const sender = accounts[instruction.accounts[0]];
    const receiver = accounts[instruction.accounts[1]];

    if (sender.toString() !== senderPublicKey) {
      return false;
    }

    if (receiver.toString() !== gameState.lotteryWalletAddress) {
      return false;
    }

    // Verify amount
    const transferredAmount = transaction.meta.preBalances[1] - transaction.meta.postBalances[1];
    const transferredSOL = transferredAmount / LAMPORTS_PER_SOL;
    
    const tolerance = 0.001;
    if (Math.abs(transferredSOL - expectedAmount) > tolerance) {
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error verifying transaction:', error);
    return false;
  }
}

// Transfer funds to winner with platform fees
async function transferToWinnerWithFees(winnerPublicKey) {
  if (!connection || !gameState.lotteryWallet) return null;

  try {
    const { PublicKey } = require('@solana/web3.js');
    const winnerPubkey = new PublicKey(winnerPublicKey);
    const platformFeePubkey = new PublicKey(PLATFORM_FEE_WALLET);
    const lotteryBalance = await connection.getBalance(gameState.lotteryWallet.publicKey);
    
    // Calculate amounts
    const totalBalance = lotteryBalance;
    const transactionFeeReserve = 0.002 * LAMPORTS_PER_SOL; // Reserve for 2 transactions
    const availableBalance = totalBalance - transactionFeeReserve;
    
    const platformFeeAmount = Math.floor(availableBalance * PLATFORM_FEE_PERCENTAGE);
    const winnerAmount = availableBalance - platformFeeAmount;

    if (availableBalance <= 0 || winnerAmount <= 0) {
      console.error('Insufficient balance for transfer');
      return null;
    }

    // Create transaction with both transfers
    const transaction = new Transaction();
    
    // Transfer platform fee
    if (platformFeeAmount > 0) {
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: gameState.lotteryWallet.publicKey,
          toPubkey: platformFeePubkey,
          lamports: platformFeeAmount,
        })
      );
    }
    
    // Transfer remaining amount to winner
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: gameState.lotteryWallet.publicKey,
        toPubkey: winnerPubkey,
        lamports: winnerAmount,
      })
    );

    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [gameState.lotteryWallet],
      { commitment: 'confirmed' }
    );

    console.log('Payout transaction completed:', signature);
    console.log(`Winner received: ${winnerAmount / LAMPORTS_PER_SOL} SOL`);
    console.log(`Platform fee: ${platformFeeAmount / LAMPORTS_PER_SOL} SOL`);
    
    return signature;
  } catch (error) {
    console.error('Error transferring to winner:', error);
    return null;
  }
}

// Calculate win chances
function calculateWinChances() {
  gameState.participants = gameState.participants.map(participant => ({
    ...participant,
    winChance: gameState.totalPot > 0 ? (participant.amount / gameState.totalPot) * 100 : 0
  }));
}

// Start game timer
function startGameTimer() {
  if (gameTimer) return; // Timer already running
  
  gameState.gameStartTime = Date.now();
  gameState.isActive = true;
  gameState.gamePhase = 'active';
  gameState.timeRemaining = 60000; // 60 seconds
  
  console.log('=== GAME TIMER STARTED ===');
  console.log('Duration: 60 seconds');
  console.log('Smart contract wallet:', gameState.lotteryWalletAddress);
  
  gameTimer = setInterval(() => {
    const elapsed = Date.now() - gameState.gameStartTime;
    gameState.timeRemaining = Math.max(60000 - elapsed, 0);
    
    broadcast({
      type: 'gameUpdate',
      gameState: {
        lotteryWallet: gameState.lotteryWalletAddress,
        participants: gameState.participants,
        totalPot: gameState.totalPot,
        timeRemaining: gameState.timeRemaining,
        isActive: gameState.isActive,
        winner: gameState.winner,
        winnerPayoutSignature: gameState.winnerPayoutSignature,
        gamePhase: gameState.gamePhase
      }
    });
    
    if (gameState.timeRemaining === 0) {
      selectWinnerAndPayout();
    }
  }, 100);
}

// Select winner and handle payout
async function selectWinnerAndPayout() {
  if (gameState.participants.length === 0) return;
  
  const random = Math.random() * gameState.totalPot;
  let accumulated = 0;
  let winner = gameState.participants[0];
  
  for (const participant of gameState.participants) {
    accumulated += participant.amount;
    if (random <= accumulated) {
      winner = participant;
      break;
    }
  }
  
  gameState.winner = winner.publicKey;
  gameState.isActive = false;
  gameState.gamePhase = 'ended';
  gameState.timeRemaining = 0;
  
  console.log('=== ROUND ENDED ===');
  console.log('Winner selected:', winner.publicKey);
  console.log('Total pot:', gameState.totalPot, 'SOL');
  console.log('Closing smart contract wallet:', gameState.lotteryWalletAddress);
  
  // Transfer funds to winner
  try {
    const payoutSignature = await transferToWinnerWithFees(winner.publicKey);
    if (payoutSignature) {
      gameState.winnerPayoutSignature = payoutSignature;
      console.log('Payout completed. Smart contract wallet is now empty and closed.');
    }
  } catch (error) {
    console.error('Error processing winner payout:', error);
  }
  
  if (gameTimer) {
    clearInterval(gameTimer);
    gameTimer = null;
  }
  
  broadcast({
    type: 'gameUpdate',
    gameState: {
      lotteryWallet: gameState.lotteryWalletAddress,
      participants: gameState.participants,
      totalPot: gameState.totalPot,
      timeRemaining: gameState.timeRemaining,
      isActive: gameState.isActive,
      winner: gameState.winner,
      winnerPayoutSignature: gameState.winnerPayoutSignature,
      gamePhase: gameState.gamePhase
    }
  });
  
  // Automatically create new smart contract wallet after 15 seconds
  setTimeout(() => {
    console.log('=== CREATING NEW SMART CONTRACT WALLET ===');
    resetGame();
  }, 15000); // 15 seconds
}

// Reset game
function resetGame() {
  gameState.gamePhase = 'resetting';
  
  if (gameTimer) {
    clearInterval(gameTimer);
    gameTimer = null;
  }
  
  console.log('=== RESETTING GAME ===');
  console.log('Creating new smart contract wallet...');
  
  // Reset all game state
  gameState = {
    lotteryWallet: null,
    lotteryWalletAddress: null,
    participants: [],
    totalPot: 0,
    timeRemaining: 0,
    isActive: false,
    winner: null,
    gameStartTime: null,
    winnerPayoutSignature: null,
    gamePhase: 'waiting'
  };
  
  // Create new smart contract wallet
  createGameWallet();
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('New client connected');
  
  // Ensure smart contract wallet exists for new connections
  ensureGameWallet();
  
  // Send current game state to new client
  ws.send(JSON.stringify({
    type: 'gameUpdate',
    gameState: {
      lotteryWallet: gameState.lotteryWalletAddress,
      participants: gameState.participants,
      totalPot: gameState.totalPot,
      timeRemaining: gameState.timeRemaining,
      isActive: gameState.isActive,
      winner: gameState.winner,
      winnerPayoutSignature: gameState.winnerPayoutSignature,
      gamePhase: gameState.gamePhase
    }
  }));
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'placeBet':
          const { publicKey, amount, signature } = data;
          
          // Check if game has ended
          if (gameState.winner) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Round has ended. Please wait for reset.'
            }));
            return;
          }
          
          // Verify transaction in production
          if (signature) {
            if (signature.startsWith('simulation_')) {
              console.log('Simulation transaction received:', signature);
            } else {
              // In production, verify the transaction
              const isValid = await verifyTransaction(signature, amount, publicKey);
              if (!isValid) {
                ws.send(JSON.stringify({
                  type: 'error',
                  message: 'Transaction verification failed. Please try again.'
                }));
                return;
              }
              console.log('Transaction verified:', signature);
            }
          }
          
          // Check if user already participated
          const existingIndex = gameState.participants.findIndex(p => p.publicKey === publicKey);
          
          if (existingIndex >= 0) {
            // Update existing participant
            gameState.participants[existingIndex].amount += amount;
            gameState.participants[existingIndex].signature = signature;
          } else {
            // Add new participant
            gameState.participants.push({
              publicKey,
              amount,
              winChance: 0,
              timestamp: Date.now(),
              signature: signature || 'demo'
            });
            
            // Start timer if this is the first participant
            if (gameState.participants.length === 1) {
              console.log('=== ROUND STARTED ===');
              console.log('First bet placed on smart contract wallet');
              console.log('Starting 60-second timer');
              startGameTimer();
            }
          }
          
          gameState.totalPot += amount;
          calculateWinChances();
          
          broadcast({
            type: 'gameUpdate',
            gameState: {
              lotteryWallet: gameState.lotteryWalletAddress,
              participants: gameState.participants,
              totalPot: gameState.totalPot,
              timeRemaining: gameState.timeRemaining,
              isActive: gameState.isActive,
              winner: gameState.winner,
              winnerPayoutSignature: gameState.winnerPayoutSignature,
              gamePhase: gameState.gamePhase
            }
          });
          
          ws.send(JSON.stringify({
            type: 'betPlaced',
            message: `Bet of ${amount} SOL placed successfully!`
          }));
          
          break;
          
        case 'resetGame':
          resetGame();
          break;
          
        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('Error processing message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  });
  
  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Create initial smart contract wallet
  console.log('=== SOLANA LOTTERY SERVER STARTED ===');
  console.log('Creating initial smart contract wallet...');
  ensureGameWallet();
});
