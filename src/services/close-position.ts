/**
 * Close position service
 * Handles closing positions on Jupiter Perpetuals
 */

import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createCloseAccountInstruction,
  NATIVE_MINT,
} from "@solana/spl-token";
import { Perpetuals } from "../idl/jupiter-perpetuals-idl.js";
import {
  initializeProgram,
  generatePositionRequestPda,
  JLP_POOL_ACCOUNT_PUBKEY,
  JUPITER_PERPETUALS_PROGRAM_ID,
} from "../utils/program.js";
import { signAndSendTransaction, type TransactionSigner } from "../utils/transactions.js";
import { findPositionByAssetAndSide } from "../utils/position.js";
import { TOKENS, USDC_MINT_ADDRESS } from "../constants.js";
import { PositionSide } from "../types.js";

/**
 * Construct a transaction for closing a market position
 * @param program Jupiter Perpetuals Program instance
 * @param connection Solana RPC connection
 * @param positionPubkey Position public key to close
 * @param desiredMint Mint address for receiving collateral (USDC)
 * @param priorityFeeMicroLamports Priority fee in microLamports per compute unit
 * @returns Versioned transaction ready to sign
 */
async function constructClosePositionTransaction(
  program: Program<Perpetuals>,
  connection: Connection,
  positionPubkey: PublicKey,
  desiredMint: PublicKey,
  priorityFeeMicroLamports: number
): Promise<VersionedTransaction> {
  // Fetch the position data
  const position = await program.account.position.fetch(positionPubkey, "confirmed");

  // Generate position request PDA for decrease
  const { positionRequest, counter } = generatePositionRequestPda({
    positionPubkey,
    requestChange: "decrease",
  });

  // Get position request ATA
  const positionRequestAta = getAssociatedTokenAddressSync(
    desiredMint,
    positionRequest,
    true
  );

  // Get receiving account (user's ATA)
  const receivingAccount = getAssociatedTokenAddressSync(
    desiredMint,
    position.owner,
    true
  );

  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];

  // If desired mint is native SOL, close the wrapped SOL account after
  if (desiredMint.equals(NATIVE_MINT)) {
    postInstructions.push(
      createCloseAccountInstruction(receivingAccount, position.owner, position.owner)
    );
  }

  // Get recent blockhash
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  // Create decrease position instruction
  const decreaseIx = await program.methods
    .createDecreasePositionMarketRequest({
      collateralUsdDelta: new BN(0),
      sizeUsdDelta: new BN(0),
      priceSlippage: position.side.long
        ? new BN("0", 10)
        : new BN("18446744073709551615", 10),
      jupiterMinimumOut: null,
      counter,
      entirePosition: true,
    })
    .accounts({
      owner: position.owner,
      receivingAccount,
      perpetuals: PublicKey.findProgramAddressSync(
        [Buffer.from("perpetuals")],
        JUPITER_PERPETUALS_PROGRAM_ID
      )[0],
      pool: JLP_POOL_ACCOUNT_PUBKEY,
      position: positionPubkey,
      positionRequest,
      positionRequestAta: positionRequestAta,
      custody: position.custody,
      collateralCustody: position.collateralCustody,
      desiredMint,
      referral: null,
    })
    .instruction();

  // Build instructions array with temporary high compute limit for simulation
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_400_000, // Temporary high limit for simulation
    }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFeeMicroLamports,
    }),
    ...preInstructions,
    decreaseIx,
    ...postInstructions,
  ];

  // Simulate to get accurate compute units
  const simulateTx = new VersionedTransaction(
    new TransactionMessage({
      instructions,
      payerKey: position.owner,
      recentBlockhash: blockhash,
    }).compileToV0Message([])
  );

  const simulation = await connection.simulateTransaction(simulateTx, {
    replaceRecentBlockhash: true,
    sigVerify: false,
    commitment: "confirmed",
  });

  // Safety check: If simulation failed, throw error rather than proceeding
  if (simulation.value.err) {
    throw new Error(
      `Simulation failed: ${JSON.stringify(simulation.value.err)}\n` +
      `Logs: ${JSON.stringify(simulation.value.logs)}`
    );
  }

  // Get compute units with safety checks
  let computeUnits: number;
  if (simulation.value.unitsConsumed && simulation.value.unitsConsumed > 0) {
    // Add 20% buffer for safety (account for variations in actual execution)
    computeUnits = Math.ceil(simulation.value.unitsConsumed * 1.2);

    // Check if exceeds Solana's hard limit (1.4M compute units per transaction)
    if (computeUnits > 1_400_000) {
      throw new Error(
        `Transaction requires ${computeUnits} compute units (with 20% buffer), ` +
        `but Solana limit is 1,400,000. Transaction will fail. ` +
        `Base units consumed: ${simulation.value.unitsConsumed}`
      );
    }
  } else {
    // If unitsConsumed is invalid, fail rather than guess
    throw new Error(
      `Simulation succeeded but returned invalid unitsConsumed: ${simulation.value.unitsConsumed}`
    );
  }

  // Replace compute unit limit with accurate value
  instructions[0] = ComputeBudgetProgram.setComputeUnitLimit({
    units: computeUnits,
  });

  // Build final transaction
  const txMessage = new TransactionMessage({
    payerKey: position.owner,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  return new VersionedTransaction(txMessage);
}

/**
 * Close a position by asset and side
 * @param connection Solana RPC connection
 * @param walletKeypair Wallet keypair for signing
 * @param walletAddress Wallet address (base58)
 * @param asset Asset symbol (SOL, ETH, BTC)
 * @param side Position side (Long or Short)
 * @param priorityFeeMicroLamports Priority fee in microLamports per compute unit
 * @returns Transaction signature and position summary
 */
export async function closePosition(
  connection: Connection,
  walletKeypair: TransactionSigner,
  walletAddress: string,
  asset: string,
  side: PositionSide,
  priorityFeeMicroLamports: number
): Promise<{ signature: string; position_closed: string }> {
  // Initialize program
  const program = initializeProgram(connection);

  // Find the position
  const positionPubkey = await findPositionByAssetAndSide(walletAddress, asset, side);

  // USDC is the only supported collateral mint
  const desiredMint = new PublicKey(USDC_MINT_ADDRESS);

  // Construct the transaction
  const transaction = await constructClosePositionTransaction(
    program,
    connection,
    positionPubkey,
    desiredMint,
    priorityFeeMicroLamports
  );

  // Sign and send the transaction
  const signature = await signAndSendTransaction(transaction, connection, walletKeypair);

  return {
    signature,
    position_closed: `Closed ${side} ${asset} position`,
  };
}
