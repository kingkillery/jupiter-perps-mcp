/**
 * Transaction utilities for signing and sending transactions
 */

import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";

/**
 * Sign and send a transaction
 * @param transaction Versioned transaction to send
 * @param connection Solana RPC connection
 * @param signer Keypair to sign the transaction
 * @returns Transaction signature
 */
export async function signAndSendTransaction(
  transaction: VersionedTransaction,
  connection: Connection,
  signer: Keypair
): Promise<string> {
  // Sign the transaction
  transaction.sign([signer]);

  // Send the transaction
  const signature = await connection.sendTransaction(transaction, {
    preflightCommitment: "confirmed",
  });

  // Return signature immediately (matching original behavior)
  // Confirmation is handled by Solana validators
  return signature;
}
