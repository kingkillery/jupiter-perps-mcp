"""One bounded, offline inference request. stdin/stdout contain public market data only."""
import contextlib
import json
import math
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / ".runtime/kronos-source"))

def main():
    request = json.loads(sys.stdin.read(262144))
    candles = request["candles"]
    horizon = request["horizon"]
    step = request["interval_ms"]
    if type(horizon) is not int or not 1 <= horizon <= 24 or step not in (300000, 900000, 3600000):
        raise ValueError("Unsupported forecast settings")
    if len(candles) != 128:
        raise ValueError("128 completed candles required")
    previous = None
    for bar in candles:
        for key in ("time", "open", "high", "low", "close", "volume"):
            value = bar[key]
            if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                raise ValueError("Invalid candle")
        if min(bar[k] for k in ("open", "high", "low", "close")) <= 0:
            raise ValueError("Invalid price")
        if bar["high"] < max(bar["open"], bar["close"]) or bar["low"] > min(bar["open"], bar["close"]):
            raise ValueError("Invalid OHLC")
        if previous is not None and bar["time"] != previous + step:
            raise ValueError("Discontinuous candles")
        previous = bar["time"]

    # Upstream libraries may print diagnostics; reserve stdout for the JSON protocol.
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import pandas as pd
        import torch
        from model import Kronos, KronosTokenizer, KronosPredictor
        torch.set_num_threads(4)
        torch.set_num_interop_threads(1)
        torch.manual_seed(42)
        np.random.seed(42)
        model_dir = root / ".runtime/kronos-models"
        # Loading local safetensors avoids pickle and remote model code.
        tokenizer = KronosTokenizer.from_pretrained(str(model_dir / "tokenizer"), local_files_only=True)
        model = Kronos.from_pretrained(str(model_dir / "model"), local_files_only=True)
        tokenizer.eval()
        model.eval()
        predictor = KronosPredictor(model, tokenizer, device="cpu", max_context=2048)
        frame = pd.DataFrame(candles)
        frame["amount"] = frame["volume"] * frame[["open", "high", "low", "close"]].mean(axis=1)
        future = [previous + step * (i + 1) for i in range(horizon)]
        # Kronos time features use UTC, represented as timezone-naive timestamps.
        x_time = pd.Series(pd.to_datetime(frame["time"], unit="ms", utc=True).dt.tz_localize(None))
        y_time = pd.Series(pd.to_datetime(future, unit="ms", utc=True).tz_localize(None))
        with torch.inference_mode():
            prediction = predictor.predict(
                df=frame[["open", "high", "low", "close", "volume", "amount"]],
                x_timestamp=x_time, y_timestamp=y_time, pred_len=horizon,
                T=1.0, top_p=0.9, sample_count=3, verbose=False)
        closes = prediction["close"].tolist()
    if len(closes) != horizon or any(not math.isfinite(v) or v <= 0 for v in closes):
        raise ValueError("Model produced invalid forecast values")
    print(json.dumps({"forecast": [{"time": t, "close": float(v)} for t, v in zip(future, closes)]}, allow_nan=False))

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ": " + str(error), file=sys.stderr)
        sys.exit(1)
