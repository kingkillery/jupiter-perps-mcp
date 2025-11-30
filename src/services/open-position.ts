/**
 * Open position service
 * Handles opening/increasing positions on Jupiter Perpetuals
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
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT,
} from "@solana/spl-token";
import { Perpetuals } from "../idl/jupiter-perpetuals-idl.js";
import {
  initializeProgram,
  generatePositionPda,
  generatePositionRequestPda,
  JLP_POOL_ACCOUNT_PUBKEY,
  JUPITER_PERPETUALS_PROGRAM_ID,
} from "../utils/program.js";
import { signAndSendTransaction } from "../utils/transactions.js";
import { getTokenInfo, USDC_MINT_ADDRESS } from "../constants.js";
import { PositionSide } from "../types.js";

/**
 * Construct a transaction for opening/increasing a position
 * @param program Jupiter Perpetuals Program instance
 * @param connection Solana RPC connection
 * @param walletPublicKey Wallet public key
 * @param asset Asset symbol (SOL, ETH, BTC)
 * @param side Position side (Long or Short)
 * @param collateralAmount Collateral amount in USDC
 * @param leverage Leverage multiplier
 * @param priorityFeeMicroLamports Priority fee in microLamports per compute unit
 * @returns Versioned transaction and position pubkey
 */
async function constructOpenPositionTransaction(
  program: Program<Perpetuals>,
  connection: Connection,
  walletPublicKey: PublicKey,
  asset: string,
  side: PositionSide,
  collateralAmount: number,
  leverage: number,
  priorityFeeMicroLamports: number
): Promise<{ transaction: VersionedTransaction; positionPubkey: PublicKey }> {
  // Get asset token info
  const assetToken = getTokenInfo(asset);
  const assetCustodyPubkey = assetToken.custodyAccount;

  // Determine collateral custody based on side
  // Long: collateral custody = asset custody (protocol swaps USDC → asset internally)
  // Short: collateral custody = USDC custody
  const collateralCustodyPubkey =
    side === "Long" ? assetCustodyPubkey : getTokenInfo("USDC").custodyAccount;

  // Generate position PDA
  const { position: positionPubkey } = generatePositionPda({
    custody: assetCustodyPubkey,
    collateralCustody: collateralCustodyPubkey,
    walletAddress: walletPublicKey,
    side: side === "Long" ? "long" : "short",
  });

  // Generate position request PDA
  const { positionRequest, counter } = generatePositionRequestPda({
    positionPubkey,
    requestChange: "increase",
  });

  // Input mint is always USDC (what we pay from our wallet)
  const inputMint = new PublicKey(USDC_MINT_ADDRESS);

  // Get position request ATA and funding account
  const positionRequestAta = getAssociatedTokenAddressSync(inputMint, positionRequest, true);
  const fundingAccount = getAssociatedTokenAddressSync(inputMint, walletPublicKey);

  // Calculate amounts (USDC has 6 decimals)
  const collateralTokenDelta = new BN(Math.floor(collateralAmount * 1_000_000));
  const sizeUsd = collateralAmount * leverage;
  const sizeUsdDelta = new BN(Math.floor(sizeUsd * 1_000_000));

  // Jupiter minimum out for swaps (long positions need this)
  // TODO: Call Jupiter Quote API to calculate proper slippage
  // https://station.jup.ag/api-v6/get-quote
  let jupiterMinimumOut: BN | null = null;
  if (side === "Long") {
    jupiterMinimumOut = new BN(1); // Placeholder - not safe for production!
  }

  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];

  // Handle native SOL wrapping if input mint is SOL
  // (Not needed for USDC, but keeping for completeness)
  if (inputMint.equals(NATIVE_MINT)) {
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        walletPublicKey,
        fundingAccount,
        walletPublicKey,
        NATIVE_MINT
      )
    );

    preInstructions.push(
      SystemProgram.transfer({
        fromPubkey: walletPublicKey,
        toPubkey: fundingAccount,
        lamports: BigInt(collateralTokenDelta.toString()),
      })
    );

    preInstructions.push(createSyncNativeInstruction(fundingAccount));

    postInstructions.push(
      createCloseAccountInstruction(fundingAccount, walletPublicKey, walletPublicKey)
    );
  }

  // Get recent blockhash
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  // Create increase position instruction
  const sideEnum = side === "Long" ? { long: {} } : { short: {} };
  const increaseIx = await program.methods
    .createIncreasePositionMarketRequest({
      counter,
      collateralTokenDelta,
      jupiterMinimumOut:
        jupiterMinimumOut && jupiterMinimumOut.gten(0) ? jupiterMinimumOut : null,
      priceSlippage:
        side === "Long"
          ? new BN("18446744073709551615", 10)
          : new BN("0", 10),
      side: sideEnum,
      sizeUsdDelta,
    })
    .accounts({
      custody: assetCustodyPubkey,
      collateralCustody: collateralCustodyPubkey,
      fundingAccount,
      inputMint,
      owner: walletPublicKey,
      perpetuals: PublicKey.findProgramAddressSync(
        [Buffer.from("perpetuals")],
        JUPITER_PERPETUALS_PROGRAM_ID
      )[0],
      pool: JLP_POOL_ACCOUNT_PUBKEY,
      position: positionPubkey,
      positionRequest,
      positionRequestAta,
      referral: null,
    })
    .instruction();

  // Build instructions with temporary high compute limit for simulation
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_400_000, // Temporary high limit for simulation
    }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFeeMicroLamports,
    }),
    ...preInstructions,
    increaseIx,
    ...postInstructions,
  ];

  // Simulate to get accurate compute units
  const simulateTx = new VersionedTransaction(
    new TransactionMessage({
      instructions,
      payerKey: walletPublicKey,
      recentBlockhash: blockhash,
    }).compileToV0Message([])
  );

  const simulation = await connection.simulateTransaction(simulateTx, {
    replaceRecentBlockhash: true,
    sigVerify: false,
    commitment: "confirmed",
  });

  // Safety check: If simulation failed, throw error
  if (simulation.value.err) {
    throw new Error(
      `Simulation failed: ${JSON.stringify(simulation.value.err)}\n` +
        `Logs: ${JSON.stringify(simulation.value.logs)}`
    );
  }

  // Get compute units with safety checks
  let computeUnits: number;
  if (simulation.value.unitsConsumed && simulation.value.unitsConsumed > 0) {
    // Add 20% buffer for safety
    computeUnits = Math.ceil(simulation.value.unitsConsumed * 1.2);

    // Check if exceeds Solana's hard limit
    if (computeUnits > 1_400_000) {
      throw new Error(
        `Transaction requires ${computeUnits} compute units (with 20% buffer), ` +
          `but Solana limit is 1,400,000. Transaction will fail. ` +
          `Base units consumed: ${simulation.value.unitsConsumed}`
      );
    }
  } else {
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
    payerKey: walletPublicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  return {
    transaction: new VersionedTransaction(txMessage),
    positionPubkey,
  };
}

/**
 * Open/increase a position
 * @param connection Solana RPC connection
 * @param walletKeypair Wallet keypair for signing
 * @param asset Asset symbol (SOL, ETH, BTC)
 * @param side Position side (Long or Short)
 * @param collateralAmount Collateral amount in USDC
 * @param leverage Leverage multiplier
 * @param priorityFeeMicroLamports Priority fee in microLamports per compute unit
 * @returns Transaction signature and position summary
 */
export async function openPosition(
  connection: Connection,
  walletKeypair: Keypair,
  asset: string,
  side: PositionSide,
  collateralAmount: number,
  leverage: number,
  priorityFeeMicroLamports: number
): Promise<{ signature: string; position_opened: string }> {
  // Initialize program
  const program = initializeProgram(connection);

  // Construct the transaction
  const { transaction } = await constructOpenPositionTransaction(
    program,
    connection,
    walletKeypair.publicKey,
    asset,
    side,
    collateralAmount,
    leverage,
    priorityFeeMicroLamports
  );

  // Sign and send the transaction
  const signature = await signAndSendTransaction(transaction, connection, walletKeypair);

  return {
    signature,
    position_opened: `${side} ${asset} position with ${collateralAmount} USDC at ${leverage}x leverage`,
  };
}
