export const candidateIds = ["sol_long", "sol_short", "eth_watch", "btc_watch", "none"] as const;
export type CandidateId = typeof candidateIds[number];

export const candidateDefinitions = [
  {id:"sol_long",asset:"SOL",side:"long",label:"SOL breakout and retest",execution_scope:"analysis_only",description:"Research the saved 15-minute breakout, retest and structural-stop conditions; this choice cannot start an entry review."},
  {id:"sol_short",asset:"SOL",side:"short",label:"SOL failed bounce",execution_scope:"analysis_only",description:"Research the rejection, completed breakdown and failed rebound conditions; this choice cannot start an entry review."},
  {id:"eth_watch",asset:"ETH",side:null,label:"ETH market watch",execution_scope:"analysis_only",description:"Market analysis candidate; there is no configured ETH entry plan."},
  {id:"btc_watch",asset:"BTC",side:null,label:"BTC market watch",execution_scope:"analysis_only",description:"Market analysis candidate; there is no configured BTC entry plan."}
] as const;

export function candidateQuestions() {
  return {
    best_candidate:{type:"choice",instructions:"Which single candidate deserves the next human review based on this evidence? Choose none when the setup is unclear, data are stale, or signals conflict. This is a review routing judgment, not a trading-profit forecast.",criteria:{
      sol_long:"Saved SOL long breakout and retest; examine only if completed structure supports it.",
      sol_short:"Saved SOL short failed bounce; examine only if completed structure supports it.",
      eth_watch:"ETH deserves market research; no entry plan or execution route exists.",
      btc_watch:"BTC deserves market research; no entry plan or execution route exists.",
      none:"No candidate has enough current, consistent evidence for deeper review."
    }},
    evidence_consistent:{type:"noul",instructions:"Do the available completed candles, market summary and Kronos scenario give sufficiently consistent, current evidence to warrant human review of the selected candidate? This is not a prediction of profit."}
  };
}

export async function rankCandidateState(state:unknown, signal:AbortSignal) {
  const key=process.env.OPENROUTER_API_KEY;
  if(!key)throw new Error("OpenRouter key is not configured");
  const response=await fetch("https://openrouter.ai/api/v1/systemone",{method:"POST",headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},body:JSON.stringify({model:"jev-1.13",state,questions:candidateQuestions()}),signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});
  if(!response.ok)throw new Error(response.status===401?"OpenRouter rejected the saved API key (HTTP 401). Re-enter a valid key in the local masked prompt.":"Jev request failed (HTTP "+response.status+"). Check OpenRouter configuration and balance.");
  const raw=await response.json();
  const answer=raw?.answers?.best_candidate;
  if (!answer || answer.type!=="choice" || !candidateIds.includes(answer.choice) || typeof answer.confidence!=="number" || !Number.isFinite(answer.confidence) || answer.confidence<0 || answer.confidence>1) throw new Error("Jev returned an invalid choice");
  const probabilities:Record<CandidateId,number> = {} as Record<CandidateId,number>;
  for (const id of candidateIds) {
    const p=answer.probabilities?.[id];
    if(typeof p!=="number"||!Number.isFinite(p)||p<0||p>1) throw new Error("Jev returned an invalid candidate distribution");
    probabilities[id]=p;
  }
  if(Math.abs(Object.values(probabilities).reduce((a,b)=>a+b,0)-1)>0.02) throw new Error("Jev returned an invalid candidate distribution");
  const consistent=raw?.answers?.evidence_consistent;
  if(!consistent || consistent.type!=="noul" || typeof consistent.noul!=="number" || !Number.isFinite(consistent.noul) || consistent.noul<0 || consistent.noul>1) throw new Error("Jev returned an invalid evidence check");
  return {id:answer.choice as CandidateId,confidence:answer.confidence,probabilities,evidence_consistent:consistent.noul,model:raw.model,provider:"openrouter",usage:raw.usage??null};
}
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";

const envPath = new URL(process.env.NODE_ENV === "test" ? "../../.runtime/openrouter-e2e.env" : "../../.env", import.meta.url);

export async function saveOpenRouterKey(input:unknown) {
  if(typeof input!=="string" || !/^sk-or-[A-Za-z0-9_-]{20,256}$/.test(input)) throw new Error("Enter a complete OpenRouter key (starts with sk-or-)");
  let current="";
  try { current=await readFile(envPath,"utf8"); }
  catch(e:any) { if(e.code!=="ENOENT") throw e; }
  const line="OPENROUTER_API_KEY="+input;
  const next=/^OPENROUTER_API_KEY=.*$/m.test(current)
    ? current.replace(/^OPENROUTER_API_KEY=.*$/m,line)
    : current.replace(/\s*$/,"")+"\n"+line+"\n";
  const temp=new URL(randomUUID()+".tmp",envPath);
  try { await mkdir(new URL(".",envPath),{recursive:true}); await writeFile(temp,next,{flag:"wx",mode:0o600}); await rename(temp,envPath); }
  catch { await unlink(temp).catch(()=>{}); throw new Error("Could not save the OpenRouter key locally"); }
  process.env.OPENROUTER_API_KEY=input;
  return {configured:true};
}
