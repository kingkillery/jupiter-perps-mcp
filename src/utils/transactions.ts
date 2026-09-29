import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";

export interface TransactionSigner {
  publicKey: PublicKey;
  signal?: AbortSignal;
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>;
}

export function keypairSigner(keypair: Keypair, signal?: AbortSignal): TransactionSigner {
  return {publicKey:keypair.publicKey,signal,async signTransaction(transaction) {
    transaction.sign([keypair]); return transaction;
  }};
}

export async function signAndSendTransaction(
  transaction: VersionedTransaction, connection: Connection, signer: TransactionSigner
): Promise<string> {
  signer.signal?.throwIfAborted();
  const signed=await signer.signTransaction(transaction);
  signer.signal?.throwIfAborted();
  return await connection.sendTransaction(signed,{preflightCommitment:"confirmed"});
}
