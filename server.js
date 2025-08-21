// Verify transaction to lottery wallet
async function verifyTransaction(signature, expectedAmount, senderPublicKey) {
  if (!connection || !gameState.lotteryWallet) return false;

  try {
    console.log('Verifying transaction:', signature, 'Amount:', expectedAmount, 'Sender:', senderPublicKey);
    
    // Wait a bit for transaction to propagate
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const transaction = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (!transaction || !transaction.meta) {
      console.log('Transaction not found or no metadata');
      return false;
    }

    // Check if transaction was successful
    if (transaction.meta.err) {
      console.log('Transaction failed with error:', transaction.meta.err);
      return false;
    }

    // Verify the transaction details directly
    const instruction = transaction.transaction.message.instructions[0];
    if (!instruction) {
      console.log('No instruction found in transaction');
      return false;
    }

    const accounts = transaction.transaction.message.accountKeys;
    
    // Check if it's a system transfer
    const systemProgramId = '11111111111111111111111111111112';
    if (instruction.programId.toString() !== systemProgramId) {
      console.log('Not a system program transfer');
      return false;
    }

    // Verify sender and receiver
    const sender = accounts[instruction.accounts[0]];
    const receiver = accounts[instruction.accounts[1]];

    if (sender.toString() !== senderPublicKey) {
      console.log('Sender mismatch:', sender.toString(), 'vs', senderPublicKey);
      return false;
    }

    if (receiver.toString() !== gameState.lotteryWalletAddress) {
      console.log('Receiver mismatch:', receiver.toString(), 'vs', gameState.lotteryWalletAddress);
      return false;
    }

    // Verify amount (convert lamports to SOL)
    const preBalance = transaction.meta.preBalances[1]; // receiver's pre-balance
    const postBalance = transaction.meta.postBalances[1]; // receiver's post-balance
    const transferredLamports = postBalance - preBalance;
    const transferredSOL = transferredLamports / LAMPORTS_PER_SOL;
    
    console.log('Expected:', expectedAmount, 'SOL, Transferred:', transferredSOL, 'SOL');
    
    // Allow small tolerance for rounding errors
    const tolerance = 0.001;
    if (Math.abs(transferredSOL - expectedAmount) > tolerance) {
      console.log('Amount mismatch - Expected:', expectedAmount, 'Got:', transferredSOL);
      return false;
    }

    console.log('Transaction verification successful!');
    return true;
  } catch (error) {
    console.error('Error verifying transaction:', error);
    return false;
  }
}
