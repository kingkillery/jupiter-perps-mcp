import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { RSI, EMA, ATR } from "technicalindicators";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Candle, MarketState } from "../types.js";
import { fetchKrakenCandles } from "./candle-feed.js";
import { getMarketSnapshot } from "./market.js";
import type { KronosService } from "./kronos.js";
import { candidateDefinitions, rankCandidateState } from "./candidate-ranking.js";

const archiveRoot = new URL(process.env.NODE_ENV === "test" ? "../../.runtime/candidate-inbox-e2e/" : "../../.runtime/candidate-inbox/", import.meta.url);
const latestPath = new URL("latest.json", archiveRoot);
type Lane = {asset:string;interval:string;source:string;last_completed_time:number;last_completed_close:number;change_8_bars_pct:number;rsi_14:number;ema_21:number;atr_14:number;recent_candles:Candle[];market:MarketState|null};
function lane(asset: "SOL"|"ETH"|"BTC", interval:"15m"|"1h", bars:Candle[], source:string, market:MarketState|null):Lane {
  const closes=bars.map(c=>c.close);
  const rsi=RSI.calculate({values:closes,period:14}).at(-1);
  const ema=EMA.calculate({values:closes,period:21}).at(-1);
  const atr=ATR.calculate({high:bars.map(c=>c.high),low:bars.map(c=>c.low),close:closes,period:14}).at(-1);
  if (![rsi,ema,atr].every(v=>typeof v==="number"&&Number.isFinite(v)) || !Number.isFinite(closes.at(-1)!)) throw new Error("Incomplete technical indicators");
  return {asset,interval,source,last_completed_time:bars.at(-1)!.time,last_completed_close:closes.at(-1)!,
    change_8_bars_pct:(closes.at(-1)!/closes.at(-9)!-1)*100,
    rsi_14:rsi!,ema_21:ema!,atr_14:atr!,recent_candles:bars.slice(-12),market};
}
export const CANDIDATE_TOOLS: Tool[] = [
 {name:"scan_trade_candidates",description:"Build a read-only market snapshot and ask Jev to rank SOL plan and ETH/BTC watch candidates. Stores the complete decision locally. Does not prepare or submit transactions.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
 {name:"check_candidate_outcome",description:"Check whether the latest saved choice has an observed eight-candle SOL outcome. Research only; never trades.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
 {name:"get_candidate_inbox",description:"Read the latest saved candidate scan and its underlying evidence. Does not scan or trade.",inputSchema:{type:"object",properties:{},additionalProperties:false}}
];
export class CandidateInbox {
  private busy=false;
  constructor(private kronos:KronosService,private strategy:any,private walletConnected:()=>boolean) {}
  status(){return {busy:this.busy,provider:"openrouter",model:"typesafe/jev-1.13",configured:!!process.env.OPENROUTER_API_KEY,read_only:true};}
  async latest(){try{return JSON.parse(await readFile(latestPath,"utf8")).scan;}catch(e:any){if(e.code==="ENOENT")return null;throw e;}}
  async checkOutcome(signal=new AbortController().signal) {
    if(this.busy)throw new Error("Wait for the current candidate scan to finish");
    const scan=await this.latest();
    if(!scan)throw new Error("Scan candidates first");
    if(scan.outcome?.status==="observed")return scan.outcome;
    const lane=scan.snapshot.lanes.find((item:Lane)=>item.asset==="SOL"&&item.interval==="15m");
    if(!lane)return {status:"unavailable",reason:"No valid completed SOL candle origin in the saved scan"};
    const target=lane.last_completed_time+8*900000;
    if(Date.now()<target+900000)return {status:"pending",target_candle_time:target,reason:"The eighth future SOL candle has not completed"};
    const observed=await fetchKrakenCandles("SOL","15m",500,signal);
    const bar=observed.result.find(c=>c.time===target);
    if(!bar)return {status:"unavailable",reason:"The target candle is outside the available Kraken history"};
    const change=(bar.close/lane.last_completed_close-1)*100;
    const selected=scan.decision?.id;
    const matched=selected==="sol_long"?change>0:selected==="sol_short"?change<0:null;
    const outcome={status:"observed",target_candle_time:target,observed_close:bar.close,origin_close:lane.last_completed_close,realized_change_pct:change,
      selected_candidate:selected??null,selected_direction_matched:matched,source:observed.source,checked_at:Date.now(),
      meaning:"Spot-price direction over eight completed candles; excludes trading costs and is not a realized trade result."};
    if((await this.latest())?.id!==scan.id)throw new Error("A newer scan replaced this result; check that scan instead");
    const updated={...scan,outcome};
    const archive=JSON.stringify({scan:updated},null,2);
    const temp=new URL(scan.id+".outcome.tmp",archiveRoot);
    await writeFile(temp,archive);await rename(temp,latestPath);
    await writeFile(new URL(scan.id+".json",archiveRoot),archive);
    return outcome;
  }
  async scan(args:unknown,signal=new AbortController().signal){
    if(args && (typeof args!=="object"||Array.isArray(args)||Object.keys(args).length)) throw new Error("Scan accepts no settings");
    if(this.busy) throw new Error("A candidate scan is already running");
    this.busy=true;
    try{
      const requested=[["SOL","15m"],["SOL","1h"],["ETH","15m"],["BTC","15m"]] as const;
      const tasks=[
        getMarketSnapshot(),
        ...requested.map(([asset,interval])=>fetchKrakenCandles(asset,interval,64,signal)),
        this.kronos.forecast({asset:"SOL",interval:"15m",horizon:8},signal),
        this.kronos.latestEvaluation()
      ];
      const result=await Promise.allSettled(tasks);
      signal.throwIfAborted();
      const warnings:string[]=[];
      const marketResult=result[0];
      const market=marketResult.status==="fulfilled"?marketResult.value as Awaited<ReturnType<typeof getMarketSnapshot>>:null;
      if(!market)warnings.push("Jupiter market snapshot unavailable");
      const lanes:Lane[]=[];
      for(let i=0;i<requested.length;i++){
        const r=result[i+1];
        if(r.status!=="fulfilled"){warnings.push(requested[i].join(" ")+" completed candles unavailable");continue;}
        const snap=r.value as Awaited<ReturnType<typeof fetchKrakenCandles>>;
        try{lanes.push(lane(requested[i][0],requested[i][1],snap.result,snap.source,market?.markets.find(m=>m.asset===requested[i][0])??null));}
        catch{warnings.push(requested[i].join(" ")+" indicators unavailable");}
      }
      const forecastResult=result[5], evaluationResult=result[6];
      const forecast=forecastResult.status==="fulfilled"?forecastResult.value:null;
      if(!forecast)warnings.push("Kronos forecast unavailable");
      const evaluation=evaluationResult.status==="fulfilled" && evaluationResult.value?{
        dataset_hash:evaluationResult.value.dataset_hash,created_at:evaluationResult.value.created_at,selected_profile:evaluationResult.value.selected_profile,
        holdout:evaluationResult.value.holdout,baseline:evaluationResult.value.baseline,limitations:evaluationResult.value.limitations
      }:null;
      const generated=Date.now();
      const sol=lanes.find(l=>l.asset==="SOL"&&l.interval==="15m");
      const expires=sol?sol.last_completed_time+1800000:generated+60000;
      const snapshot={generated_at:generated,expires_at:expires,lanes,forecast,evaluation,warnings,
        strategy:{asset:"SOL",status:this.strategy.status,long:this.strategy.long,short:this.strategy.short,risk:this.strategy.risk},
        candidates:candidateDefinitions,wallet_connected:this.walletConnected()};
      const key=process.env.OPENROUTER_API_KEY;
      let decision:any=null,ranked:any[]=[],status="unconfigured";
      if(key && sol && Date.now()<expires){
        // The hosted model receives market evidence and plan levels, never wallet identity, balances, transactions or keys.
        const state={time:generated,expires_at:expires,lanes:lanes.map(({recent_candles,...summary})=>({...summary,recent_candles:recent_candles.slice(-6)})),
          kronos:forecast?{last_close:forecast.last_completed_close,end_change_pct:forecast.end_change_pct,generated_at:forecast.generated_at,method:forecast.method}:null,
          evaluation:evaluation?{holdout:evaluation.holdout,baseline:evaluation.baseline,limitations:evaluation.limitations}:null,
          plan:{long:this.strategy.long,short:this.strategy.short},candidates:candidateDefinitions.map(c=>({id:c.id,description:c.description})),warnings};
        decision=await rankCandidateState(state,signal);
        ranked=candidateDefinitions.map(c=>({...c,selection_share:decision.probabilities[c.id]})).sort((a,b)=>b.selection_share-a.selection_share);
        status=decision.id==="none" || decision.evidence_consistent<0.5 || decision.confidence<0.5?"watch":"research_flagged";
      }else if(!key)warnings.push("OpenRouter key is not configured; candidate states collected without model ranking");
      else warnings.push("Fresh completed SOL candles unavailable; Jev ranking skipped");
      signal.throwIfAborted();
      const scan={id:randomUUID(),created_at:Date.now(),snapshot_hash:createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
        snapshot,decision,ranked,status,read_only:true,submitted:false,
        limitation:"Jev's choice probabilities express research preference, not profit odds. Research scans have no connection to entry review, transaction preparation or wallet approval."};
      await mkdir(archiveRoot,{recursive:true});
      const archive=JSON.stringify({scan},null,2);
      await writeFile(new URL(scan.id+".json",archiveRoot),archive,{flag:"wx"});
      const temp=new URL(scan.id+".tmp",archiveRoot);await writeFile(temp,archive,{flag:"wx"});await rename(temp,latestPath);
      return scan;
    }finally{this.busy=false;}
  }
}
