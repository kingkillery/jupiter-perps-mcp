"""Ephemeral, research-only Kronos sampling sweep on one Modal L4 GPU."""

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
STEP_MS = 900_000
HORIZON = 8
PER_PHASE = 12
LOOKBACK = 64
SETTINGS = (
    ("current_sampling", 1.0, 0.9, 3),
    ("lower_temperature", 0.7, 0.9, 3),
    ("wider_nucleus", 1.0, 1.0, 3),
    ("more_paths", 1.0, 0.9, 5),
)

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
app = modal.App("jupiter-kronos-research-sweep")


@app.function(image=image, gpu="L4", timeout=900, max_containers=1)
def run_sweep():
    import sys

    import numpy as np
    import pandas as pd
    import torch

    sys.path.insert(0, "/opt/kronos")
    from model import Kronos, KronosPredictor, KronosTokenizer

    with open("/opt/kronos/candles.json", encoding="utf-8") as handle:
        dataset = json.load(handle)
    candles = dataset["candles"]
    source_sha = hashlib.sha256(json.dumps(candles, separators=(",", ":")).encode()).hexdigest()
    if source_sha != EXPECTED_SHA or dataset["sha256"] != EXPECTED_SHA or len(candles) != 2880:
        raise ValueError("Unexpected source data")
    for i, candle in enumerate(candles):
        if candle["time"] != dataset["start"] + i * STEP_MS:
            raise ValueError("Non-contiguous input candles")
    if not torch.cuda.is_available():
        raise RuntimeError("Modal GPU unavailable")
    tokenizer = KronosTokenizer.from_pretrained("/opt/kronos/weights/tokenizer", local_files_only=True)
    model = Kronos.from_pretrained("/opt/kronos/weights/model", local_files_only=True)
    tokenizer.eval()
    model.eval()
    predictor = KronosPredictor(model, tokenizer, device="cuda:0", max_context=2048)
    stride = (len(candles) - 128 - HORIZON) // (PER_PHASE * 2)
    origins = [128 + i * stride for i in range(PER_PHASE)]
    result_rows = []
    for name, temperature, top_p, samples in SETTINGS:
        for index, origin in enumerate(origins):
            context = candles[origin - LOOKBACK : origin]
            labels = candles[origin : origin + HORIZON]
            if context[-1]["time"] + STEP_MS != labels[0]["time"]:
                raise ValueError("Outcome touches the wrong context")
            torch.manual_seed(42)
            torch.cuda.manual_seed_all(42)
            np.random.seed(42)
            frame = pd.DataFrame(context)
            frame["amount"] = frame["volume"] * frame[["open", "high", "low", "close"]].mean(axis=1)
            x_time = pd.Series(pd.to_datetime(frame["time"], unit="ms", utc=True).dt.tz_localize(None))
            future = [context[-1]["time"] + STEP_MS * (n + 1) for n in range(HORIZON)]
            y_time = pd.Series(pd.to_datetime(future, unit="ms", utc=True).tz_localize(None))
            with torch.inference_mode():
                prediction = predictor.predict(
                    df=frame[["open", "high", "low", "close", "volume", "amount"]],
                    x_timestamp=x_time, y_timestamp=y_time, pred_len=HORIZON,
                    T=temperature, top_p=top_p, sample_count=samples, verbose=False,
                )
            values = [float(x) for x in prediction["close"].tolist()]
            result_rows.append({
                "candidate": name, "window": index, "origin_time": context[-1]["time"],
                "origin_close": context[-1]["close"], "future_times": future,
                "actual": [c["close"] for c in labels], "predicted": values,
            })
    scores = []
    for name, temperature, top_p, samples in SETTINGS:
        subset = [row for row in result_rows if row["candidate"] == name]
        metrics = {}
        for alpha in (0.0, 0.5, 1.0):
            errors = [
                abs(row["origin_close"] + alpha * (prediction - row["origin_close"]) - actual)
                for row in subset
                for prediction, actual in zip(row["predicted"], row["actual"])
            ]
            metrics[str(alpha)] = sum(errors) / len(errors)
        scores.append({"candidate": name, "temperature": temperature, "top_p": top_p,
                       "sample_count": samples, "windows": len(subset), "points": len(subset) * HORIZON,
                       "mae_by_alpha": metrics})
    return {
        "research_only": True, "source_sha256": source_sha, "gpu": torch.cuda.get_device_name(0),
        "source_start": dataset["start"], "source_end": dataset["end"],
        "phase": "previously_inspected_development_windows", "lookback": LOOKBACK,
        "horizon": HORIZON, "stride_candles": stride,
        "model_revision": "f4e68697d9d5aed55cef5c96aabc3376bcad9f81",
        "tokenizer_revision": "26966d0035065a0cae0ebad7af8ece35bc1fb51c",
        "source_revision": "67b630e67f6a18c9e9be918d9b4337c960db1e9a",
        "scores": scores, "rows": result_rows,
        "limitations": ["Exploratory sweep on already-inspected historical development windows.",
                        "No clean holdout, live setting change, wallet action, or trade."],
    }


@app.local_entrypoint()
def main():
    report = run_sweep.remote()
    report["recorded_at"] = datetime.now(timezone.utc).isoformat()
    destination = ROOT / ".runtime/kronos-modal-tuning"
    destination.mkdir(parents=True, exist_ok=True)
    path = destination / "latest.json"
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(path), "gpu": report["gpu"], "source_sha256": report["source_sha256"],
                      "trial_count": len(report["scores"]), "scores": report["scores"]}, indent=2))
