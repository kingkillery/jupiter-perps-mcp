"""Download only configs and safetensors from pinned, official model revisions."""
import json
from pathlib import Path
from huggingface_hub import hf_hub_download

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / "kronos/manifest.json").read_text())
for name in ("model", "tokenizer"):
    spec = manifest[name]
    for filename in ("config.json", "model.safetensors"):
        hf_hub_download(repo_id=spec["id"], revision=spec["revision"], filename=filename,
                        local_dir=root / ".runtime/kronos-models" / name, token=False)
print("Kronos model and tokenizer installed.")
