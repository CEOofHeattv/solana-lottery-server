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
  
  console.log('=== NEW GAME WALLET CREATED ===');
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
    console.log('Verifying transaction:', signature, 'Amount:', expectedAmount, 'Sender:', senderPublicKey);
    
    const transaction = await connection.getTransaction(signature, {
      commitment: 'confirmed'
    });

    console.log('Transaction fetched:', !!transaction);
    
    if (!transaction || !transaction.meta || transaction.meta.err) {
      console.error('Transaction not found, has no meta, or has error');
      return false;
    }

    // Simplified verification - check balance changes instead of instruction details
    const accounts = transaction.transaction.message.accountKeys;
    
    if (!accounts || accounts.length === 0) {
      console.error('No accounts in transaction');
      return false;
    }

    // Find sender and receiver in account keys
    let senderIndex = -1;
    let receiverIndex = -1;
    
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      if (account.toString() === senderPublicKey) {
        senderIndex = i;
      }
      if (account.toString() === gameState.lotteryWalletAddress) {
        receiverIndex = i;
      }
    }
    
    console.log('Sender index:', senderIndex, 'Receiver index:', receiverIndex);
    
    if (senderIndex === -1) {
      console.error('Sender not found in transaction accounts');
      return false;
    }
    
    if (receiverIndex === -1) {
      console.error('Receiver not found in transaction accounts');
      return false;
    }

    // Verify amount
    if (!transaction.meta.preBalances || !transaction.meta.postBalances) {
      console.error('Missing balance information');
      return false;
    }
    
    if (transaction.meta.preBalances.length <= receiverIndex || transaction.meta.postBalances.length <= receiverIndex) {
      console.error('Balance arrays too short for receiver index');
      return false;
    }
    
    // Calculate the balance change for the receiver (lottery wallet)
    const receiverBalanceChange = transaction.meta.postBalances[receiverIndex] - transaction.meta.preBalances[receiverIndex];
    const transferredSOL = receiverBalanceChange / LAMPORTS_PER_SOL;
    
    console.log('Receiver balance change:', receiverBalanceChange, 'lamports');
    console.log('Transferred SOL:', transferredSOL, 'Expected:', expectedAmount);
    
    // Also verify sender balance decreased (optional additional check)
    if (senderIndex < transaction.meta.preBalances.length && senderIndex < transaction.meta.postBalances.length) {
      const senderBalanceChange = transaction.meta.postBalances[senderIndex] - transaction.meta.preBalances[senderIndex];
      console.log('Sender balance change:', senderBalanceChange, 'lamports (should be negative)');
    }
    
    const tolerance = 0.001;
    if (Math.abs(transferredSOL - expectedAmount) > tolerance) {
      console.error(`Amount mismatch: expected ${expectedAmount}, got ${transferredSOL}`);
      return false;
    }

    console.log('Transaction verification successful');
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
  console.log('Game wallet:', gameState.lotteryWalletAddress);
  
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
  console.log('Closing lottery wallet:', gameState.lotteryWalletAddress);
  
  // Transfer funds to winner
  try {
    const payoutSignature = await transferToWinnerWithFees(winner.publicKey);
    if (payoutSignature) {
      gameState.winnerPayoutSignature = payoutSignature;
      console.log('Payout completed. Wallet is now empty and closed.');
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
  
  // Automatically create new game wallet after 15 seconds
  setTimeout(() => {
    console.log('=== CREATING NEW GAME WALLET ===');
    resetGame();
  }, 15000); // Changed to 15 seconds
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
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('New client connected');
  
  // Ensure lottery wallet exists
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
              console.log('First bet placed, starting 60-second timer');
              console.log('Lottery wallet:', gameState.lotteryWalletAddress);
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
  
  // Create initial lottery wallet
  ensureGameWallet();
});
