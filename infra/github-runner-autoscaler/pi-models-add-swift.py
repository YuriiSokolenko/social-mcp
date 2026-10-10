#!/usr/bin/env python3
"""Add the Swift (TensorFold) model to a host Pi models.json, idempotently.

Usage: sudo python3 pi-models-add-swift.py <PI_HOME_HOST>/.pi/agent/models.json
Keeps every existing provider/model/secret, writes a timestamped backup first,
and preserves the file owner and mode (UID 1001 on N150).
"""
import json
import os
import shutil
import sys
import time
path = sys.argv[1]
with open(path) as fh:
    config = json.load(fh)
models = config["providers"]["hp-laguna"]["models"]
if any(m.get("id") == "swift-1.5-qwen3.8-flash-next" for m in models):
    print("swift already present; no change")
    sys.exit(0)
backup = f"{path}.bak-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
shutil.copy2(path, backup)
models.append({
    "id": "swift-1.5-qwen3.8-flash-next",
    "name": "Swift 1.5 (Qwen 3.8 Flash Next, TensorFold)",
    "reasoning": True,
    "input": ["text"],
    "contextWindow": 262144,
    "maxTokens": 32000,
    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
})
st = os.stat(path)
tmp = f"{path}.tmp"
with open(tmp, "w") as fh:
    json.dump(config, fh, indent=2)
    fh.write("\n")
os.chown(tmp, st.st_uid, st.st_gid)
os.chmod(tmp, st.st_mode & 0o777)
os.replace(tmp, path)
print(f"added swift; backup {backup}")
