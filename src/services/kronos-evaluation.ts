import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Candle } from "../types.js";
import { fetchKrakenCandles } from "./candle-feed.js";

const root = new URL(process.env.NODE_ENV === "test" ? "../../.runtime/kronos-evaluations-e2e/" : "../../.runtime/kronos-evaluations/", import.meta.url);
const latest = new URL("latest.json", root);
const steps = { "5m": 300000, "15m": 900000, "1h": 3600000 } as const;
const profiles = [{ id: "default-128", lookback: 128 }, { id: "short-64", lookback: 64 }];
const windows = 12, split = 6;
type Input = { asset: "SOL" | "ETH" | "BTC"; interval: keyof typeof steps; horizon: number };
type Point = { time: number; close: number };
type Row = { window: number; phase: string; profile: string; context_start: number; context_end: number; origin_close: number; actual: Point[]; predicted: Point[] };

export const KRONOS_EVALUATION_TOOL: Tool = {
  name: "evaluate_kronos",
  description: "Evaluate two Kronos context lengths on 12 historical candle snippets. Select by earlier-six-window MAE and score on six later windows; includes unchanged-price baseline. Research only; never changes live settings or trades. Allow up to eight minutes.",
  inputSchema: { type: "object", additionalProperties: false, properties: {
    asset: { type: "string", enum: ["SOL", "ETH", "BTC"], default: "SOL" },
    interval: { type: "string", enum: ["5m", "15m", "1h"], default: "15m" },
    horizon: { type: "integer", minimum: 1, maximum: 24, default: 8 }
  } }
};

function inputSettings(args: unknown): Input {
  if (args === undefined) args = {};
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(k => !["asset", "interval", "horizon"].includes(k))) throw new Error("Unsupported evaluation setting");
  const {asset = "SOL", interval = "15m", horizon = 8} = args as Input;
  if (!["SOL", "ETH", "BTC"].includes(asset) || !Object.hasOwn(steps, interval) || !Number.isInteger(horizon) || horizon < 1 || horizon > 24) throw new Error("Choose SOL, ETH or BTC; 5m, 15m or 1h; and 1–24 candles");
  return {asset, interval, horizon};
}

function metrics(rows: Row[]) {
  const errors = rows.flatMap(row => row.actual.map((p, i) => ({ error: row.predicted[i].close - p.close, actual: p.close })));
  const count = errors.length;
  const sign = (n: number) => Math.abs(n) < 1e-10 ? 0 : Math.sign(n);
  const correct = rows.filter(r => sign(r.predicted.at(-1)!.close - r.origin_close) === sign(r.actual.at(-1)!.close - r.origin_close)).length;
  return {
    windows: rows.length, points: count,
    mae_usd: errors.reduce((sum, p) => sum + Math.abs(p.error), 0) / count,
    rmse_usd: Math.sqrt(errors.reduce((sum, p) => sum + p.error ** 2, 0) / count),
    mape_pct: errors.reduce((sum, p) => sum + Math.abs(p.error) / p.actual, 0) / count * 100,
    direction_correct: correct, direction_total: rows.length, direction_accuracy_pct: correct / rows.length * 100
  };
}
function improvement(candidate: number, baseline: number) {
  return baseline > 0 ? (1 - candidate / baseline) * 100 : null;
}

export async function latestEvaluation() {
  try { return JSON.parse(await readFile(latest, "utf8")).report; }
  catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
}

export async function evaluateKronos(args: unknown, signal: AbortSignal, infer: (request: unknown, signal: AbortSignal, timeout?: number) => Promise<any>, manifest: any) {
  const input = inputSettings(args);
  const step = steps[input.interval], count = 128 + windows * input.horizon;
  const snapshot = await fetchKrakenCandles(input.asset, input.interval, count, signal);
  const candles = snapshot.result;
  const datasetHash = createHash("sha256").update(JSON.stringify(candles)).digest("hex");

  async function run(phase: string, from: number, to: number, configs: typeof profiles): Promise<Row[]> {
    const jobs = [];
    for (let i = from; i < to; i++) for (const profile of configs) {
      const origin = 128 + i * input.horizon;
      // The inference worker receives only the past context, never the scoring labels.
      jobs.push({window:i, profile, context:candles.slice(origin - profile.lookback, origin), actual:candles.slice(origin, origin + input.horizon)});
    }
    const output = await infer({ requests: jobs.map(j => ({candles:j.context, horizon:input.horizon, interval_ms:step})) }, signal, 240000);
    if (!Array.isArray(output?.results) || output.results.length !== jobs.length) throw new Error("Incomplete evaluation output");
    return jobs.map((job, index) => {
      const forecast = output.results[index]?.forecast;
      if (!Array.isArray(forecast) || forecast.length !== input.horizon) throw new Error("Incomplete evaluation forecast");
      const predicted = forecast.map((p: any, n: number) => {
        if (!p || p.time !== job.context.at(-1)!.time + step * (n + 1) || typeof p.close !== "number" || !Number.isFinite(p.close) || p.close <= 0) throw new Error("Invalid evaluation forecast");
        return {time:p.time, close:p.close};
      });
      return {window:job.window, phase, profile:job.profile.id, context_start:job.context[0].time, context_end:job.context.at(-1)!.time,
        origin_close:job.context.at(-1)!.close, actual:job.actual.map(p => ({time:p.time, close:p.close})), predicted};
    });
  }

  const tuningRows = await run("selection", 0, split, profiles);
  const tuning = profiles.map(profile => ({...profile, ...metrics(tuningRows.filter(r => r.profile === profile.id))}));
  // Freeze selection before any holdout inference or scoring. Ties retain the default.
  const selected = tuning.reduce((best, next) => next.mae_usd < best.mae_usd ? next : best);
  const heldProfiles = profiles.filter(p => p.id === profiles[0].id || p.id === selected.id);
  const heldRows = await run("holdout", split, windows, heldProfiles);
  const baselineRows = heldRows.filter(r => r.profile === profiles[0].id).map(r => ({
    ...r, profile:"unchanged-price", predicted:r.actual.map(p => ({time:p.time, close:r.origin_close}))
  }));
  const baseline = metrics(baselineRows);
  const holdout = heldProfiles.map(p => ({...p, ...metrics(heldRows.filter(r => r.profile === p.id))}));
  const picked = holdout.find(p => p.id === selected.id)!;
  const defaultScore = holdout.find(p => p.id === profiles[0].id)!;
  const beatsBaseline = picked.mae_usd < baseline.mae_usd;
  const beatsDefault = picked.mae_usd < defaultScore.mae_usd;
  const report = {
    id:randomUUID(), created_at:Date.now(), ...input, source:snapshot.source,
    dataset_hash:datasetHash, model:manifest.model, source_revision:manifest.source_revision,
    start_time:candles[0].time, end_time:candles.at(-1)!.time, candle_count:count,
    selection_windows:split, holdout_windows:windows-split,
    holdout_start:candles[128+split*input.horizon].time,
    profiles, sampling:{samples:3,seed:42,temperature:1,top_p:0.9},
    selected_profile:selected.id, selection_metric:"Earlier-window mean absolute closing-price error (USD); ties keep default-128.",
    tuning, holdout, baseline:{id:"unchanged-price", ...baseline},
    improvement_vs_baseline_pct:improvement(picked.mae_usd,baseline.mae_usd),
    improvement_vs_default_pct:improvement(picked.mae_usd,defaultScore.mae_usd),
    conclusion: selected.id !== profiles[0].id && beatsBaseline && beatsDefault
      ? "Shorter context improved holdout MAE in this small pilot. Collect new, untouched periods before adopting it."
      : !beatsBaseline ? "The selected profile did not beat the unchanged-price baseline on holdout. No evidence to adopt a tuning change."
      : "The pilot does not establish a tuning improvement over the default. Keep the current settings and collect more periods.",
    limitations:[
      "Only six non-overlapping holdout forecast windows; not statistical proof or a trading win rate.",
      "Historical replay uses no future labels in each model input, but pretrained-model training overlap cannot be ruled out for arbitrary historical data.",
      "Repeatedly inspecting the same holdout turns it into development data; use new periods for subsequent confirmation.",
      "Spot-price closing accuracy excludes trading fees, slippage, liquidation and PnL.",
      "This tests context length only; model weights and live forecast settings are unchanged."
    ],
    rows:[...tuningRows,...heldRows,...baselineRows], read_only:true, submitted:false, live_settings_changed:false
  };
  signal.throwIfAborted();
  await mkdir(root,{recursive:true});
  const archive = JSON.stringify({report,candles},null,2);
  await writeFile(new URL(report.id+".json",root),archive,{flag:"wx"});
  const temporary = new URL(report.id+".tmp",root);
  await writeFile(temporary,archive,{flag:"wx"});
  await rename(temporary,latest);
  return report;
}
