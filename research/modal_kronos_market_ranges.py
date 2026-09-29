"""Exploratory SOL range replay for fixed 15-minute and hourly sessions."""

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import modal


ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT / ".runtime/kronos-long-history/coinbase-sol-usd-15m-20260816-20260915.json"
MODEL = ROOT / ".runtime/kronos-models/model"
TOKENIZER = ROOT / ".runtime/kronos-models/tokenizer"
SOURCE = ROOT / ".runtime/kronos-source/model"
EXPECTED_SHA = "71d0428e1d39bda0c2b9dd5fe2e9da6ad17f7e488b3b116071e3833e83a94e16"
ORIGINS = [int(datetime(2026, 9, day, 12, tzinfo=timezone.utc).timestamp() * 1000)
           for day in range(7, 15)]

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch==2.14.0", "numpy==2.2.6", "pandas==2.3.3", "einops==0.8.1",
        "huggingface_hub==0.33.1", "safetensors==0.6.2", "tqdm==4.67.1"
    )
    .add_local_file(DATASET, "/opt/kronos/candles.json")
    .add_local_file(SOURCE / "__init__.py", "/opt/kronos/model/__init__.py")
    .add_local_file(SOURCE / "kronos.py", "/opt/kronos/model/kronos.py")
    .add_local_file(SOURCE / "module.py", "/opt/kronos/model/module.py")
    .add_local_file(MODEL / "config.json", "/opt/kronos/weights/model/config.json")
    .add_local_file(MODEL / "model.safetensors", "/opt/kronos/weights/model/model.safetensors")
    .add_local_file(TOKENIZER / "config.json", "/opt/kronos/weights/tokenizer/config.json")
    .add_local_file(TOKENIZER / "model.safetensors", "/opt/kronos/weights/tokenizer/model.safetensors")
)
app = modal.App("jupiter-kronos-market-ranges")


@app.function(image=image, gpu="L4", timeout=900, max_containers=1)
def replay():
    import sys

    import numpy as np
    import pandas as pd
    import torch

    sys.path.insert(0, "/opt/kronos")
    from model import Kronos, KronosPredictor, KronosTokenizer

    with open("/opt/kronos/candles.json", encoding="utf-8") as handle:
        dataset = json.load(handle)
    bars = dataset["candles"]
    source_sha = hashlib.sha256(json.dumps(bars, separators=(",", ":")).encode()).hexdigest()
    if dataset["sha256"] != EXPECTED_SHA or source_sha != EXPECTED_SHA or len(bars) != 2880:
        raise ValueError("Unexpected Coinbase candle archive")
    if not torch.cuda.is_available():
        raise RuntimeError("Modal GPU unavailable")

    hourly = []
    for i in range(0, len(bars), 4):
        group = bars[i:i + 4]
        if len(group) != 4 or any(c["time"] != group[0]["time"] + n * 900_000
                                  for n, c in enumerate(group)):
            raise ValueError("Incomplete hourly aggregation")
        hourly.append({"time": group[0]["time"], "open": group[0]["open"],
                       "high": max(c["high"] for c in group),
                       "low": min(c["low"] for c in group),
                       "close": group[-1]["close"],
                       "volume": sum(c["volume"] for c in group)})

    tokenizer = KronosTokenizer.from_pretrained("/opt/kronos/weights/tokenizer", local_files_only=True)
    model = Kronos.from_pretrained("/opt/kronos/weights/model", local_files_only=True)
    tokenizer.eval()
    model.eval()
    predictor = KronosPredictor(model, tokenizer, device="cuda:0", max_context=2048)
    rows = []
    for interval, series, step in (("15m", bars, 900_000), ("1h", hourly, 3_600_000)):
        by_time = {bar["time"]: i for i, bar in enumerate(series)}
        for origin in ORIGINS:
            index = by_time[origin]
            context = series[index - 64:index]
            actual = series[index]
            if len(context) != 64 or context[-1]["time"] + step != origin:
                raise ValueError("Incorrect forecast boundary")
            torch.manual_seed(42)
            torch.cuda.manual_seed_all(42)
            np.random.seed(42)
            frame = pd.DataFrame(context)
            frame["amount"] = frame["volume"] * frame[["open", "high", "low", "close"]].mean(axis=1)
            x_time = pd.Series(pd.to_datetime(frame["time"], unit="ms", utc=True).dt.tz_localize(None))
            y_time = pd.Series(pd.to_datetime([origin], unit="ms", utc=True).tz_localize(None))
            with torch.inference_mode():
                prediction = predictor.predict(
                    df=frame[["open", "high", "low", "close", "volume", "amount"]],
                    x_timestamp=x_time, y_timestamp=y_time, pred_len=1,
                    T=1.0, top_p=0.9, sample_count=3, verbose=False,
                )
            predicted = {key: float(prediction.iloc[0][key]) for key in ("open", "high", "low", "close")}
            if not (predicted["low"] <= min(predicted["open"], predicted["close"])
                    <= max(predicted["open"], predicted["close"]) <= predicted["high"]):
                raise ValueError("Invalid model OHLC output")
            rows.append({"interval": interval, "origin_time": origin,
                         "context_close": context[-1]["close"],
                         "previous": {k: context[-1][k] for k in ("high", "low", "close")},
                         "predicted": predicted,
                         "actual": {k: actual[k] for k in ("open", "high", "low", "close")}})
    return {"research_only": True, "source_sha256": source_sha, "lookback": 64,
            "sample_count": 3, "seed": 42, "temperature": 1.0, "top_p": 0.9,
            "model_revision": "f4e68697d9d5aed55cef5c96aabc3376bcad9f81",
            "tokenizer_revision": "26966d0035065a0cae0ebad7af8ece35bc1fb51c",
            "source_revision": "67b630e67f6a18c9e9be918d9b4337c960db1e9a",
            "session_rule": "Sep 7-14 2026, 12:00 UTC each day; one next candle per interval",
            "limitations": ["Exploratory historical windows drawn from an already inspected archive.",
                            "Coinbase spot OHLC differs from prediction-market settlement sources.",
                            "OHLC point forecasts are not calibrated outcome probabilities."],
            "rows": rows}


@app.local_entrypoint()
def main():
    report = replay.remote()
    report["recorded_at"] = datetime.now(timezone.utc).isoformat()
    destination = ROOT / ".runtime/kronos-market-ranges"
    destination.mkdir(parents=True, exist_ok=True)
    path = destination / "latest.json"
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"path": str(path), "rows": len(report["rows"]),
                      "source_sha256": report["source_sha256"]}))
