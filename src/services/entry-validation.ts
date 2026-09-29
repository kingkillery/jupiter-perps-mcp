import { BorshInstructionCoder } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { IDL } from "../idl/jupiter-perpetuals-idl.js";
import { TOKENS } from "../constants.js";
import { generatePositionPda, JLP_POOL_ACCOUNT_PUBKEY, JUPITER_PERPETUALS_PROGRAM_ID as PROGRAM } from "../utils/program.js";
import type { EntryContext, EntryInput } from "./entry-controls.js";

const micro=(n:number)=>BigInt(Math.floor(n*1e6+1e-7));
function usd(v:unknown):number{
 if((typeof v!=="string"&&typeof v!=="number")||String(v).trim()===""||!Number.isFinite(Number(v))||Number(v)<0)throw new Error("Missing or invalid prepared quote value");
 return Number(v)/1e6;
}
// Only direct USDC collateral is understood here. Unsupported swap/ledger routes fail closed.
export async function validateEntryTransaction(tx:VersionedTransaction,prepared:any,ctx:EntryContext,address:string,input:EntryInput,view:any,orders:any[]){
 if(input.side!=="short")throw new Error("Unvalidated collateral conversion route");
 const wallet=new PublicKey(address),position=generatePositionPda({walletAddress:wallet,custody:TOKENS.SOL.custodyAccount,collateralCustody:TOKENS.USDC.custodyAccount,side:"short"}).position;
 if(prepared.positionPubkey!==position.toBase58())throw new Error("Unexpected entry position");
 if(!tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures).some(k=>k.equals(wallet)))throw new Error("Missing wallet signer");
 if(!tx.message.staticAccountKeys[0].equals(wallet))throw new Error("Unsupported fee payer");
 if(await ctx.connection.getAccountInfo(position,"confirmed"))throw new Error("Position already exists on chain; no increases allowed");
 const tables=await Promise.all(tx.message.addressTableLookups.map(async l=>{const r=await ctx.connection.getAddressLookupTable(l.accountKey);if(!r.value)throw new Error("Lookup table unavailable");return r.value;}));
 const message=TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:tables}),coder=new BorshInstructionCoder(IDL);
 const remaining=[...orders],requests=new Set<string>();let entries=0;let budgetLimit=false,budgetPrice=false,ataCount=0;
 for(const ix of message.instructions){
  if(ix.programId.equals(ComputeBudgetProgram.programId)){
   if(ix.data[0]===2&&!budgetLimit&&ix.data.length===5&&ix.data.readUInt32LE(1)>0&&ix.data.readUInt32LE(1)<=1400000){budgetLimit=true;continue;}
   if(ix.data[0]===3&&!budgetPrice&&ix.data.length===9&&ix.data.readBigUInt64LE(1)<=BigInt(ctx.priorityFee)){budgetPrice=true;continue;}
   throw new Error("Unsupported or excessive compute fee");
  }
  if(ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)){
   if(++ataCount>1||ix.keys.length!==6||ix.data.length!==1||ix.data[0]!==1||!ix.keys[0]?.pubkey.equals(wallet)||!ix.keys[2]?.pubkey.equals(wallet)||!ix.keys[3]?.pubkey.equals(TOKENS.USDC.mint)||!ix.keys[1]?.pubkey.equals(getAssociatedTokenAddressSync(TOKENS.USDC.mint,wallet))||!ix.keys[4]?.pubkey.equals(SystemProgram.programId)||!ix.keys[5]?.pubkey.equals(TOKEN_PROGRAM_ID))throw new Error("Unexpected token account creation");
   continue;
  }
  if(!ix.programId.equals(PROGRAM))throw new Error("Unsupported program or swap; no signature requested");
  const decoded=coder.decode(ix.data);if(!decoded)throw new Error("Unknown entry instruction");
  const def=IDL.instructions.find(i=>i.name===decoded.name)!;
  if(ix.keys.length!==def.accounts.length)throw new Error("Unexpected entry accounts");
  const accounts=new Map<string,string>(def.accounts.map((a,i)=>[a.name,ix.keys[i]?.pubkey.toBase58()]));
  const expected={owner:address,position:position.toBase58(),pool:JLP_POOL_ACCOUNT_PUBKEY.toBase58(),custody:TOKENS.SOL.custodyAccount.toBase58(),collateralCustody:TOKENS.USDC.custodyAccount.toBase58(),tokenProgram:TOKEN_PROGRAM_ID.toBase58(),systemProgram:SystemProgram.programId.toBase58(),associatedTokenProgram:ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),program:PROGRAM.toBase58(),referral:PROGRAM.toBase58()};
  for(const [key,value]of Object.entries(expected))if(accounts.has(key)&&accounts.get(key)!==value)throw new Error("Unexpected "+key+" in entry");
  const params=(decoded.data as any).params;
  if(decoded.name==="instantIncreasePosition"){
   if(++entries!==1||accounts.get("tokenLedger")!==PROGRAM.toBase58())throw new Error("Unsupported entry or token-ledger route");
   if(accounts.get("fundingAccount")!==getAssociatedTokenAddressSync(TOKENS.USDC.mint,wallet).toBase58()||params.collateralTokenDelta?.toString()!==micro(input.collateral_usdc).toString()||params.sizeUsdDelta?.toString()!==micro(view.size_usd).toString()||params.side?.short===undefined)throw new Error("Prepared entry amount or side differs from preview");
   const bound=Number(params.priceSlippage?.toString())/1e6;
   if(!Number.isFinite(bound)||bound+1e-6<view.adverse_entry_price||bound>view.entry_price)throw new Error("Prepared entry slippage exceeds reviewed bound");
  }else if(decoded.name==="instantCreateTpsl"&&entries===1){
   if(accounts.get("desiredMint")!==TOKENS.USDC.mint.toBase58()||accounts.get("receivingAccount")!==getAssociatedTokenAddressSync(TOKENS.USDC.mint,wallet).toBase58())throw new Error("Unexpected protection receiving account");
   if(params.collateralUsdDelta?.toString()!=="0")throw new Error("Unexpected collateral withdrawal");
   const index=remaining.findIndex(o=>params.triggerPrice?.toString()===o.triggerPrice&&params.entirePosition===o.entirePosition&&params.sizeUsdDelta?.toString()===o.sizeUsdDelta&&params.triggerAboveThreshold===(o.requestType==="sl"));
   if(index<0)throw new Error("Stop or equal-third target differs from the preview");
   const request=accounts.get("positionRequest")!;
   if(requests.has(request))throw new Error("Duplicate protective request account");
   const expectedRequest=PublicKey.findProgramAddressSync([Buffer.from("position_request"),position.toBuffer(),Buffer.from(params.counter.toArrayLike(Buffer,"le",8)),Buffer.from([2])],PROGRAM)[0];
   if(request!==expectedRequest.toBase58()||accounts.get("positionRequestAta")!==getAssociatedTokenAddressSync(TOKENS.USDC.mint,expectedRequest,true).toBase58())throw new Error("Unexpected protective request address");
   requests.add(request);remaining.splice(index,1);
  }else throw new Error("Entry must atomically install the stop and three equal-third targets");
 }
 if(entries!==1||remaining.length)throw new Error("Entry is missing its stop or equal-third targets; no signature requested");
 const q=prepared.quote;
 const price=usd(q?.averagePriceUsd),size=usd(q?.sizeUsdDelta);
 if(Math.abs(size-view.size_usd)>1e-6||price+1e-6<view.adverse_entry_price||price>view.entry_price)throw new Error("Prepared quote changed; preview again");
 const lev=Number(q?.leverage);
 if(!Number.isFinite(lev)||lev<=0||lev>Math.min(7,input.leverage,ctx.strategy.risk.max_leverage))throw new Error("Prepared leverage exceeds reviewed cap");
 if(usd(q?.positionCollateralUsd)>input.collateral_usdc||usd(q?.positionCollateralUsd)<=0)throw new Error("Invalid prepared collateral");
 if(usd(q?.liquidationPriceUsd)<=view.stop_price)throw new Error("Liquidation must remain beyond the stop");
 const fee=usd(q?.openFeeUsd)+usd(q?.priceImpactFeeUsd)+usd(q?.outstandingBorrowFeeUsd);
 if(fee>view.risk.entry_fees_usd+1e-6)throw new Error("Entry fees changed; preview again");
}
