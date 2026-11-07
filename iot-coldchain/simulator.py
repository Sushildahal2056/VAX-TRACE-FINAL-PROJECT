#!/usr/bin/env python3
"""Push simulated probe readings into the off-chain API / on-chain oracle."""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def post(url: str, body: dict, address: str) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-wallet-address": address},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read().decode())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="http://127.0.0.1:4000")
    parser.add_argument("--batch", default="1")
    parser.add_argument("--interval", type=float, default=2.0)
    parser.add_argument("--readings", type=int, default=8)
    parser.add_argument("--breach-at", type=int, default=6, help="1-based index of an out-of-range reading; 0 disables")
    args = parser.parse_args()

    demo = json.loads((ROOT / "demo-accounts.json").read_text())
    iot = next(a for a in demo["accounts"] if a["role"] == "iot")

    for i in range(1, args.readings + 1):
        temp_c = 25.4 if args.breach_at and i == args.breach_at else 4.6 + (i % 3) * 0.3
        centi = int(round(temp_c * 100))
        try:
            result = post(
                f"{args.api}/api/iot/reading",
                {"batchId": args.batch, "temperatureCenti": centi, "source": "sim-probe-01"},
                iot["address"],
            )
            print(f"[{i}] {temp_c:.1f}°C  hash={result.get('sha256')}  chain={result.get('onChain')}")
        except urllib.error.HTTPError as err:
            print(f"[{i}] HTTP {err.code}: {err.read().decode()}")
            raise
        if i < args.readings:
            time.sleep(args.interval)


if __name__ == "__main__":
    main()
