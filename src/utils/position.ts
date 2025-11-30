/**
 * Position finding utilities
 */

import { PublicKey } from "@solana/web3.js";
import { fetchPositions } from "../api.js";
import { getTokenInfo } from "../constants.js";
import { PositionSide } from "../types.js";

/**
 * Find a position by asset and side
 * @param walletAddress Wallet address to search positions for
 * @param asset Asset symbol (SOL, ETH, BTC)
 * @param side Position side (Long or Short)
 * @returns Position public key
 * @throws Error if position not found or multiple positions found
 */
export async function findPositionByAssetAndSide(
  walletAddress: string,
  asset: string,
  side: PositionSide
): Promise<PublicKey> {
  // Get all positions for the wallet
  const positionsResponse = await fetchPositions(walletAddress);

  // Get the mint address for the asset
  const tokenInfo = getTokenInfo(asset);
  const targetMint = tokenInfo.mint.toBase58();

  // Filter positions by market mint and side
  const matchingPositions = positionsResponse.dataList.filter((pos) => {
    const positionSide = pos.side.toLowerCase() === "long" ? "Long" : "Short";
    return pos.marketMint === targetMint && positionSide === side;
  });

  if (matchingPositions.length === 0) {
    throw new Error(
      `No ${side} position found for ${asset}. Please check your open positions.`
    );
  }

  if (matchingPositions.length > 1) {
    // This should not happen due to "one-way positions" design, but handle it anyway
    throw new Error(
      `Multiple ${side} positions found for ${asset}. This should not happen. ` +
        `Position pubkeys: ${matchingPositions.map((p) => p.positionPubkey).join(", ")}`
    );
  }

  return new PublicKey(matchingPositions[0].positionPubkey);
}
