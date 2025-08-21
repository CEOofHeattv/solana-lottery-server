const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

// Create HTTP server for serving static files
const server = http.createServer((req, res) => {
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

// Import Solana dependencies with error handling
let Connection, Keypair, clusterApiUrl, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL, PublicKey;

try {
  const solanaWeb3 = require('@solana/web3.js');
  Connection = solanaWeb3.Connection;
  Keypair = solanaWeb3.Keypair;
  clusterApiUrl = solanaWeb3.clusterApiUrl;
  SystemProgram = solanaWeb3.SystemProgram;
  Transaction = solanaWeb3.Transaction;
  sendAndConfirmTransaction = solanaWeb3.sendAndConfirmTransaction;
  LAMPORTS_PER_SOL = solanaWeb3.LAMPORTS_PER_SOL;
  PublicKey = solanaWeb3.PublicKey;
  console.log('Solana Web3.js loaded successfully');
} catch (error) {
  console.error('Failed to load Solana Web3.js:', error);
  console.log('Server will run in simulation mode only');
}

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
if (Connection && clusterApiUrl) {
  try {
    connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
    console.log('Connected to Solana devnet');
  } catch (error) {
    console.error('Failed to connect to Solana:', error);
  }
} else {
  console.log('Solana Web3.js not available - running in simulation mode');
}

// Broadcast to all connected clients
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

function createGameWallet() {
  if (!Keypair) {
    // Simulation mode
    const simulationWallet = 'SIM_WALLET_' + Date.now();
    gameState.lotteryWallet = null;
    gameState.lotteryWalletAddress = simulationWallet;
    gameState.gamePhase = 'waiting';
    
    console.log('=== SIMULATION WALLET CREATED ===');
    console.log('Address:', simulationWallet);
    
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
    
    return null;
  }

  // Real wallet mode
  const lotteryWallet = Keypair.generate();
  gameState.lotteryWallet = lotteryWallet;
  gameState.lotteryWalletAddress = lotteryWallet.publicKey.toString();
  gameState.gamePhase = 'waiting';
  
  console.log('=== NEW SMART CONTRACT WALLET CREATED ===');
  console.log('Address:', gameState.lotteryWalletAddress);
  console.log('Phase: Waiting for first bet');
  
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
  if (!gameState.lotteryWallet && !gameState.lotteryWalletAddress) {
    return createGameWallet();
  }
  return gameState.lotteryWallet;
}

// Verify transaction to lottery wallet
async function verifyTransaction(signature, expectedAmount, senderPublicKey) {
  if (!connection || !gameState.lotteryWallet || !LAMPORTS_PER_SOL) {
    console.log('Cannot verify transaction - missing dependencies or simulation mode');
    return false;
  }

  try {
    console.log('Attempting to verify real transaction:', signature);
    console.log('Expected amount:', expectedAmount, 'SOL');
    console.log('Sender:', senderPublicKey);
    console.log('Lottery wallet:', gameState.lotteryWalletAddress);
    
    // Wait for transaction to propagate
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const transaction = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    console.log('Transaction fetched:', !!transaction);

    if (!transaction || !transaction.meta) {
      console.log('Transaction not found or no metadata');
      return false;
    }

    if (transaction.meta.err) {
      console.log('Transaction failed with error:', transaction.meta.err);
      return false;
    }

    // Debug: Log the entire transaction structure
    console.log('=== TRANSACTION DEBUG INFO ===');
    console.log('Transaction message keys:', transaction.transaction.message.accountKeys ? 'legacy format' : 'versioned format');
    
    if (transaction.transaction.message.accountKeys) {
      console.log('Legacy format - Account keys count:', transaction.transaction.message.accountKeys.length);
      console.log('Legacy format - Instructions count:', transaction.transaction.message.instructions.length);
      
      // Log all instructions
      transaction.transaction.message.instructions.forEach((inst, i) => {
        const programId = inst.programId ? inst.programId.toString() : 
                         (inst.programIdIndex !== undefined ? transaction.transaction.message.accountKeys[inst.programIdIndex].toString() : 'unknown');
        console.log(`Instruction ${i}: Program ID = ${programId}`);
      });
    } else if (transaction.transaction.message.staticAccountKeys) {
      console.log('Versioned format - Static account keys count:', transaction.transaction.message.staticAccountKeys.length);
      console.log('Versioned format - Compiled instructions count:', transaction.transaction.message.compiledInstructions.length);
      
      // Log all compiled instructions
      transaction.transaction.message.compiledInstructions.forEach((inst, i) => {
        const programId = transaction.transaction.message.staticAccountKeys[inst.programIdIndex].toString();
        console.log(`Compiled Instruction ${i}: Program ID = ${programId}`);
      });
    }
    console.log('=== END TRANSACTION DEBUG ===');
    
    // Handle different transaction message formats
    let accounts, transferInstruction;
    
    if (transaction.transaction.message.accountKeys) {
      // Legacy format
      accounts = transaction.transaction.message.accountKeys;
    } else if (transaction.transaction.message.staticAccountKeys) {
      // Versioned transaction format
      accounts = transaction.transaction.message.staticAccountKeys;
    } else {
      console.log('Unknown transaction format');
      return false;
    }

    if (!accounts || accounts.length === 0) {
      console.log('No accounts found');
      console.log('Accounts length:', accounts ? accounts.length : 0);
      return false;
    }

    // Handle multiple instructions - look for the transfer instruction
    let transferInstructionIndex = -1;
    
    if (transaction.transaction.message.instructions) {
      // Legacy format - check all instructions
      for (let i = 0; i < transaction.transaction.message.instructions.length; i++) {
        const inst = transaction.transaction.message.instructions[i];
        let programId;
        
        if (inst.programId) {
          programId = inst.programId.toString();
        } else if (inst.programIdIndex !== undefined) {
          programId = accounts[inst.programIdIndex].toString();
        } else {
          console.log(`Legacy instruction ${i}: No programId or programIdIndex found`);
          continue;
        }
        
        console.log(`Legacy instruction ${i}: Program ID = ${programId}`);
        
        if (programId === '11111111111111111111111111111112') {
          console.log(`Found System Program transfer at instruction ${i}`);
          transferInstruction = inst;
          transferInstructionIndex = i;
          break;
        }
      }
    } else if (transaction.transaction.message.compiledInstructions) {
      // Versioned format - check all compiled instructions
      for (let i = 0; i < transaction.transaction.message.compiledInstructions.length; i++) {
        const inst = transaction.transaction.message.compiledInstructions[i];
        
        if (inst.programIdIndex === undefined || inst.programIdIndex >= accounts.length) {
          console.log(`Compiled instruction ${i}: Invalid programIdIndex ${inst.programIdIndex}`);
          continue;
        }
        
        const programId = accounts[inst.programIdIndex].toString();
        console.log(`Compiled instruction ${i}: Program ID = ${programId}`);
        
        if (programId === '11111111111111111111111111111112') {
          console.log(`Found System Program transfer at compiled instruction ${i}`);
          transferInstruction = inst;
          transferInstructionIndex = i;
          break;
        }
      }
    } else {
      console.log('No instructions or compiledInstructions found in transaction');
      return false;
    }
    
    if (!transferInstruction) {
      console.log('No system program transfer instruction found');
      console.log('Available instructions were logged above - none matched System Program ID 11111111111111111111111111111112');
      return false;
    }
    
    console.log('Found transfer instruction at index:', transferInstructionIndex);

    // Get program ID - handle both formats
    let programId;
    if (transferInstruction.programId) {
      programId = transferInstruction.programId.toString();
    } else if (transferInstruction.programIdIndex !== undefined) {
      programId = accounts[transferInstruction.programIdIndex].toString();
    } else {
      console.log('Cannot determine program ID');
      return false;
    }
    
    // Verify it's a system program transfer
    const systemProgramId = '11111111111111111111111111111112';
    if (programId !== systemProgramId) {
      console.log('Not a system program transfer, program ID:', programId);
      return false;
    }

    // Get sender and receiver accounts - handle both formats
    let sender, receiver;
    if (transferInstruction.accounts) {
      // Legacy format
      sender = accounts[transferInstruction.accounts[0]];
      receiver = accounts[transferInstruction.accounts[1]];
    } else if (transferInstruction.accountKeyIndexes) {
      // Versioned format
      sender = accounts[transferInstruction.accountKeyIndexes[0]];
      receiver = accounts[transferInstruction.accountKeyIndexes[1]];
    } else if (transferInstruction.accounts !== undefined) {
      // Handle array of account indices
      sender = accounts[transferInstruction.accounts[0]];
      receiver = accounts[transferInstruction.accounts[1]];
    } else {
      console.log('Cannot determine sender/receiver accounts');
      console.log('Instruction properties:', Object.keys(transferInstruction));
      return false;
    }

    console.log('Transaction sender:', sender.toString());
    console.log('Expected sender:', senderPublicKey);
    console.log('Transaction receiver:', receiver.toString());
    console.log('Expected receiver:', gameState.lotteryWalletAddress);

    if (sender.toString() !== senderPublicKey) {
      console.log('Sender mismatch');
      return false;
    }

    if (receiver.toString() !== gameState.lotteryWalletAddress) {
      console.log('Receiver mismatch');
      return false;
    }

    // Verify amount
    const preBalance = transaction.meta.preBalances[1];
    const postBalance = transaction.meta.postBalances[1];
    const transferredLamports = postBalance - preBalance;
    const transferredSOL = transferredLamports / LAMPORTS_PER_SOL;
    
    console.log('Pre-balance:', preBalance, 'lamports');
    console.log('Post-balance:', postBalance, 'lamports');
    console.log('Transferred:', transferredLamports, 'lamports =', transferredSOL, 'SOL');
    console.log('Expected:', expectedAmount, 'SOL');
    
    const tolerance = 0.001;
    if (Math.abs(transferredSOL - expectedAmount) > tolerance) {
      console.log('Amount mismatch - tolerance exceeded');
      return false;
    }

    console.log('Transaction verification successful!');
    return true;
  } catch (error) {
    console.error('Error verifying transaction:', error);
    return false;
  }
}

// Transfer funds to winner with platform fees
async function transferToWinnerWithFees(winnerPublicKey) {
  if (!connection || !gameState.lotteryWallet || !PublicKey || !Transaction || !SystemProgram || !sendAndConfirmTransaction) {
    console.log('Cannot transfer - missing dependencies or simulation mode');
    return null;
  }

  try {
    const winnerPubkey = new PublicKey(winnerPublicKey);
    const platformFeePubkey = new PublicKey(PLATFORM_FEE_WALLET);
    const lotteryBalance = await connection.getBalance(gameState.lotteryWallet.publicKey);
    
    const totalBalance = lotteryBalance;
    const transactionFeeReserve = 0.002 * LAMPORTS_PER_SOL;
    const availableBalance = totalBalance - transactionFeeReserve;
    
    const platformFeeAmount = Math.floor(availableBalance * PLATFORM_FEE_PERCENTAGE);
    const winnerAmount = availableBalance - platformFeeAmount;

    if (availableBalance <= 0 || winnerAmount <= 0) {
      console.error('Insufficient balance for transfer');
      return null;
    }

    const transaction = new Transaction();
    
    if (platformFeeAmount > 0) {
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: gameState.lotteryWallet.publicKey,
          toPubkey: platformFeePubkey,
          lamports: platformFeeAmount,
        })
      );
    }
    
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
  if (gameTimer) return;
  
  gameState.gameStartTime = Date.now();
  gameState.isActive = true;
  gameState.gamePhase = 'active';
  gameState.timeRemaining = 60000;
  
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
  
  // Transfer funds to winner (only in real mode)
  if (gameState.lotteryWallet && connection) {
    try {
      const payoutSignature = await transferToWinnerWithFees(winner.publicKey);
      if (payoutSignature) {
        gameState.winnerPayoutSignature = payoutSignature;
        console.log('Payout completed. Smart contract wallet is now empty and closed.');
      }
    } catch (error) {
      console.error('Error processing winner payout:', error);
    }
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
  
  // Auto-reset after 15 seconds
  setTimeout(() => {
    console.log('=== CREATING NEW SMART CONTRACT WALLET ===');
    resetGame();
  }, 15000);
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
  
  createGameWallet();
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('New client connected');
  
  ensureGameWallet();
  
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
          
          if (gameState.winner) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Round has ended. Please wait for reset.'
            }));
            return;
          }
          
          // Verify transaction if signature provided and not simulation
          if (signature && !signature.startsWith('simulation') && !signature.startsWith('SIM_')) {
            console.log('Verifying real transaction:', signature);
            
            // Try verification with retries for slow network
            let isValid = false;
            let attempts = 0;
            const maxAttempts = 3;
            
            while (!isValid && attempts < maxAttempts) {
              attempts++;
              console.log(`Verification attempt ${attempts}/${maxAttempts} for:`, signature);
              
              isValid = await verifyTransaction(signature, amount, publicKey);
              
              if (!isValid && attempts < maxAttempts) {
                console.log(`Attempt ${attempts} failed, waiting 5 seconds before retry...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
              }
            }
            
            if (!isValid) {
              console.log('Transaction verification failed after all attempts:', signature);
              ws.send(JSON.stringify({
                type: 'error',
                message: `Transaction verification failed after ${maxAttempts} attempts. The transaction may still be processing on the network.`
              }));
              return;
            }
            console.log('Transaction verified successfully:', signature);
          } else {
            console.log('Simulation transaction received:', signature);
          }
          
          // Add or update participant
          const existingIndex = gameState.participants.findIndex(p => p.publicKey === publicKey);
          
          if (existingIndex >= 0) {
            gameState.participants[existingIndex].amount += amount;
            gameState.participants[existingIndex].signature = signature;
          } else {
            gameState.participants.push({
              publicKey,
              amount,
              winChance: 0,
              timestamp: Date.now(),
              signature: signature || 'demo'
            });
            
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
  
  console.log('=== SOLANA LOTTERY SERVER STARTED ===');
  console.log('Creating initial smart contract wallet...');
  ensureGameWallet();
});
