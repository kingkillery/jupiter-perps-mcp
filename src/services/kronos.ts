import { evaluateKronos, latestEvaluation } from "./kronos-evaluation.js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { fetchKrakenCandles } from "./candle-feed.js";
import type { Candle } from "../types.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = join(root, ".runtime/kronos-venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const worker = join(root, "kronos/forecast.py");
const manifest = JSON.parse(readFileSync(join(root, "kronos/manifest.json"), "utf8"));
const STEPS = { "5m": 300000, "15m": 900000, "1h": 3600000 } as const;
const LOOKBACK = 128;
type Input = { asset: "SOL" | "ETH" | "BTC"; interval: keyof typeof STEPS; horizon: number };
type Point = { time: number; close: number };

export const KRONOS_TOOL: Tool = {
  name: "get_kronos_forecast",
  description: "Read-only local Kronos-mini forecast from 128 completed Kraken spot candles. Returns sampled mean closing prices, not a calibrated confidence estimate or an order. Never arms entries or signs transactions.",
  inputSchema: { type: "object", additionalProperties: false, properties: {
    asset: { type: "string", enum: ["SOL", "ETH", "BTC"], default: "SOL" },
    interval: { type: "string", enum: ["5m", "15m", "1h"], default: "15m" },
    horizon: { type: "integer", minimum: 1, maximum: 24, default: 8 }
  } }
};

function settings(args: unknown): Input {
  const a = args ?? {};
  if (typeof a !== "object" || Array.isArray(a) || Object.keys(a).some(k => !["asset", "interval", "horizon"].includes(k))) {
    throw new Error("Unsupported forecast setting");
  }
  const { asset = "SOL", interval = "15m", horizon = 8 } = a as Input;
  if (!["SOL", "ETH", "BTC"].includes(asset) || !Object.hasOwn(STEPS, interval) || !Number.isInteger(horizon) || horizon < 1 || horizon > 24) {
    throw new Error("Choose SOL, ETH or BTC; 5m, 15m or 1h candles; and 1–24 forecast candles");
  }
  return { asset, interval, horizon };
}

export class KronosService {
  private busy = false;
  private cache = new Map<string, { expires: number; result: any }>();

  status() {
    const ready = [
      python, worker, join(root, ".runtime/kronos-source/model/kronos.py"),
      ...["model", "tokenizer"].flatMap(name => ["config.json", "model.safetensors"].map(file => join(root, ".runtime/kronos-models", name, file)))
    ].every(p => existsSync(p));
    return { ready, busy: this.busy, model: manifest.model.id, device: "cpu", lookback: LOOKBACK,
      default_asset: "SOL", default_interval: "15m", default_horizon: 8, read_only: true };
  }

  async forecast(args: unknown, signal = new AbortController().signal) {
    const input = settings(args);
    signal.throwIfAborted();
    if (!this.status().ready) throw new Error("Kronos is not installed. Run npm run setup:kronos on this computer.");
    if (this.busy) throw new Error("A Kronos forecast is already running. Wait for it to finish.");
    this.busy = true;
    try {
      const snapshot = await fetchKrakenCandles(input.asset, input.interval, LOOKBACK, signal);
      const last = snapshot.result.at(-1)!;
      const step = STEPS[input.interval];
      const key = createHash("sha256").update(JSON.stringify({ input, candles: snapshot.result })).digest("hex");
      for (const [k, v] of this.cache) if (v.expires <= Date.now()) this.cache.delete(k);
      const cached = this.cache.get(key);
      if (cached) return { ...cached.result, cached: true };
      const payload = await this.infer({ candles: snapshot.result, horizon: input.horizon, interval_ms: step }, signal);
      signal.throwIfAborted();
      if (Date.now() - (last.time + step) > step + 120000) throw new Error("Candle data became stale during inference. Generate a fresh forecast.");
      const raw = payload?.forecast;
      if (!Array.isArray(raw) || raw.length !== input.horizon) throw new Error("Kronos returned an incomplete forecast");
      const forecast: Point[] = raw.map((p: any, i: number) => {
        if (!p || p.time !== last.time + step * (i + 1) || typeof p.close !== "number" || !Number.isFinite(p.close) || p.close <= 0) {
          throw new Error("Kronos returned invalid forecast prices or timestamps");
        }
        return { time: p.time, close: p.close };
      });
      const result = {
        ...input, model: manifest.model.id, model_revision: manifest.model.revision,
        source_revision: manifest.source_revision, candle_source: snapshot.source,
        device: "cpu", lookback: LOOKBACK, samples: 3, seed: 42, generated_at: Date.now(),
        last_completed_candle_time: last.time, last_completed_close: last.close,
        history: snapshot.result.slice(-32).map(p => ({ time: p.time, close: p.close })),
        forecast, end_change_pct: (forecast.at(-1)!.close / last.close - 1) * 100,
        method: "Mean of three sampled closing-price paths; no calibrated confidence interval.",
        turnover_input: "Estimated as base volume multiplied by mean OHLC price.",
        read_only: true, submitted: false, cached: false,
        limitation: "Experimental spot-price scenario. Not validated as a profitable SOL strategy; does not change entry conditions, risk limits or wallet approvals."
      };
      if (this.cache.size >= 12) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { expires: Date.now() + 60000, result });
      return result;
    } finally { this.busy = false; }
  }

  latestEvaluation() { return latestEvaluation(); }

  async forecastHistorical(contexts:Candle[][], signal = new AbortController().signal) {
    if(!this.status().ready)throw new Error("Install Kronos before replaying history");
    if(this.busy)throw new Error("Kronos is busy");
    if(!Array.isArray(contexts)||contexts.length<1||contexts.length>12||contexts.some(c=>c.length!==LOOKBACK))throw new Error("Historical forecast requires 1–12 contexts of 128 candles");
    for(const context of contexts) for(let i=1;i<context.length;i++) if(context[i].time!==context[i-1].time+STEPS["15m"])throw new Error("Historical candles are not contiguous");
    this.busy=true;
    try{
      const output=await this.infer({requests:contexts.map(candles=>({candles,horizon:8,interval_ms:STEPS["15m"]}))},signal,480000);
      if(!Array.isArray(output?.results)||output.results.length!==contexts.length)throw new Error("Incomplete historical Kronos forecasts");
      return output.results.map((item:any,index:number)=>{
        const forecast=item?.forecast;
        if(!Array.isArray(forecast)||forecast.length!==8)throw new Error("Incomplete historical Kronos forecast");
        return forecast.map((point:any,n:number)=>{
          if(point?.time!==contexts[index].at(-1)!.time+(n+1)*STEPS["15m"]||!Number.isFinite(point.close)||point.close<=0)throw new Error("Invalid historical Kronos forecast");
          return {time:point.time,close:point.close};
        });
      });
    }finally{this.busy=false;}
  }

  async evaluate(args: unknown, signal = new AbortController().signal) {
    signal.throwIfAborted();
    if (!this.status().ready) throw new Error("Install Kronos with npm run setup:kronos first");
    if (this.busy) throw new Error("Kronos is busy. Wait or cancel the current job.");
    this.busy = true;
    try {
      return await evaluateKronos(args, AbortSignal.any([signal, AbortSignal.timeout(480000)]), this.infer.bind(this), manifest);
    } finally { this.busy = false; }
  }

  private infer(request: unknown, signal: AbortSignal, timeoutMs = 120000): Promise<any> {
    return new Promise((resolve, reject) => {
      // Deliberately exclude wallet keys, API tokens and other parent environment values.
      const env: NodeJS.ProcessEnv = {
        HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", OMP_NUM_THREADS: "4", MKL_NUM_THREADS: "4"
      };
      for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[name]) env[name] = process.env[name];
      const child = spawn(python, ["-I", worker], { cwd: root, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let output = "", diagnostics = "", reason: Error | undefined;
      const stop = (message: string) => { reason ??= new Error(message); child.kill(); };
      const abort = () => stop("Kronos forecast cancelled");
      const timeout = setTimeout(() => stop("Kronos exceeded its inference time limit"), timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.stdout.on("data", chunk => {
        output += chunk.toString();
        if (output.length > 131072) stop("Kronos output exceeded its limit");
      });
      child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-2000); });
      child.stdin.on("error", () => stop("Could not send candles to Kronos"));
      child.on("error", () => { reason ??= new Error("Could not start the local Kronos runtime"); });
      child.on("close", code => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        if (reason) { reject(reason); return; }
        if (code !== 0) {
          console.error("Kronos worker:", diagnostics);
          reject(new Error("Kronos inference failed. Check the local server log or rerun setup:kronos.")); return;
        }
        try { resolve(JSON.parse(output)); } catch { reject(new Error("Kronos returned invalid output")); }
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}
