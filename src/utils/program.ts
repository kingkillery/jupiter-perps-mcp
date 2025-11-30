/**
 * Jupiter Perpetuals Program initialization and constants
 */

import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { IDL as JupiterPerpetualsIDL, Perpetuals } from "../idl/jupiter-perpetuals-idl.js";

/**
 * Jupiter Perpetuals Program ID
 */
export const JUPITER_PERPETUALS_PROGRAM_ID = new PublicKey(
  "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu"
);

/**
 * JLP Pool Account Pubkey
 */
export const JLP_POOL_ACCOUNT_PUBKEY = new PublicKey(
  "5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq"
);

/**
 * Initialize Jupiter Perpetuals Program
 * @param connection Solana RPC connection
 * @returns Jupiter Perpetuals Program instance
 */
export function initializeProgram(connection: Connection): Program<Perpetuals> {
  // Create a dummy wallet for the provider (we'll sign transactions separately)
  const dummyWallet = new Wallet(Keypair.generate());

  const provider = new AnchorProvider(
    connection,
    dummyWallet,
    AnchorProvider.defaultOptions()
  );

  return new Program<Perpetuals>(
    JupiterPerpetualsIDL,
    JUPITER_PERPETUALS_PROGRAM_ID,
    provider
  );
}

/**
 * Generate PDA for a position
 * @param custody Asset custody public key
 * @param collateralCustody Collateral custody public key
 * @param walletAddress Wallet public key
 * @param side Position side ('long' or 'short')
 * @returns Position PDA
 */
export function generatePositionPda({
  custody,
  collateralCustody,
  walletAddress,
  side,
}: {
  custody: PublicKey;
  collateralCustody: PublicKey;
  walletAddress: PublicKey;
  side: "long" | "short";
}): { position: PublicKey } {
  const [position] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      walletAddress.toBuffer(),
      JLP_POOL_ACCOUNT_PUBKEY.toBuffer(),
      custody.toBuffer(),
      collateralCustody.toBuffer(),
      Buffer.from(side === "long" ? [1] : [2]),
    ],
    JUPITER_PERPETUALS_PROGRAM_ID
  );

  return { position };
}

/**
 * Generate PDA for a position request
 * @param positionPubkey Position public key
 * @param requestChange Type of change ('increase' or 'decrease')
 * @returns Position request PDA and counter (as BN)
 */
export function generatePositionRequestPda({
  positionPubkey,
  requestChange,
}: {
  positionPubkey: PublicKey;
  requestChange: "increase" | "decrease";
}): { positionRequest: PublicKey; counter: BN } {
  const counter = new BN(Math.floor(Math.random() * 1_000_000_000));
  const requestChangeEnum = requestChange === "increase" ? [1] : [2];

  const [positionRequest] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position_request"),
      positionPubkey.toBuffer(),
      counter.toArrayLike(Buffer, "le", 8),
      Buffer.from(requestChangeEnum),
    ],
    JUPITER_PERPETUALS_PROGRAM_ID
  );

  return { positionRequest, counter };
}
