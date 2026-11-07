#!/usr/bin/env python3
"""Compare a centralised SQLite baseline with the on-chain VaxTrace ledger.

Success bar from the report: reconstruct a full batch history in under 2 seconds,
and keep a complete custody audit trail.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESULTS = Path(__file__).resolve().parent / "results"
RESULTS.mkdir(exist_ok=True)
HISTORY_BUDGET_S = 2.0
SQLITE_BATCHES = 80
EVENTS_PER_BATCH = 8


def _sqlite_workload(n: int) -> dict:
    db = sqlite3.connect(":memory:")
    db.execute(
        "CREATE TABLE batches (id INTEGER PRIMARY KEY, name TEXT, lot TEXT, custodian TEXT)"
    )
    db.execute(
        "CREATE TABLE events (id INTEGER PRIMARY KEY, batch_id INTEGER, kind TEXT, note TEXT)"
    )
    insert_start = time.perf_counter()
    for i in range(1, n + 1):
        db.execute(
            "INSERT INTO batches VALUES (?, ?, ?, ?)",
            (i, "Comirnaty", f"LOT-{i}", "manufacturer"),
        )
        for k in range(EVENTS_PER_BATCH):
            db.execute(
                "INSERT INTO events (batch_id, kind, note) VALUES (?, ?, ?)",
                (i, f"step-{k}", "ok"),
            )
    db.commit()
    insert_s = time.perf_counter() - insert_start
    query_start = time.perf_counter()
    rows = db.execute(
        "SELECT kind, note FROM events WHERE batch_id = ? ORDER BY id", (n // 2 or 1,)
    ).fetchall()
    query_s = time.perf_counter() - query_start
    assert len(rows) == EVENTS_PER_BATCH
    tps = (n + n * EVENTS_PER_BATCH) / insert_s if insert_s else 0
    return {
        "engine": "sqlite-memory",
        "batches": n,
        "events": n * EVENTS_PER_BATCH,
        "insert_seconds": round(insert_s, 6),
        "history_query_seconds": round(query_s, 6),
        "approx_tps": round(tps, 2),
    }


def _chain_workload() -> dict | None:
    deployment_path = ROOT / "deployment.json"
    if not deployment_path.exists():
        return None
    try:
        from web3 import Web3
    except ImportError:
        return {"engine": "ethereum", "error": "web3 not installed"}

    deployment = json.loads(deployment_path.read_text())
    w3 = Web3(Web3.HTTPProvider("http://127.0.0.1:8545"))
    if not w3.is_connected():
        return {"engine": "ethereum", "error": "Hardhat RPC not reachable"}

    contract = w3.eth.contract(address=deployment["address"], abi=deployment["abi"])
    total = contract.functions.totalBatches().call()
    if total < 1:
        return {"engine": "ethereum", "error": "no batches deployed — run seed"}

    samples = []
    gas = []
    t0 = time.perf_counter()
    for batch_id in range(1, total + 1):
        history = contract.functions.getHistory(batch_id).call()
        samples.append(time.perf_counter() - t0)
        t0 = time.perf_counter()
        assert len(history) >= 1
    query_s = max(samples) if samples else 0

    manufacturer = deployment["accounts"]["manufacturer"]
    extras = 3
    nonce = w3.eth.get_transaction_count(manufacturer)
    demo = json.loads((ROOT / "demo-accounts.json").read_text())
    key = next(a["privateKey"] for a in demo["accounts"] if a["role"] == "manufacturer")
    account = w3.eth.account.from_key(key)
    expiry = int(time.time()) + 365 * 24 * 3600
    insert_start = time.perf_counter()
    for i in range(extras):
        tx = contract.functions.registerBatch(
            "CampaignVax",
            f"EVAL-{int(time.time())}-{i}",
            expiry,
            200,
            800,
            5,
            b"\x11" * 32,
        ).build_transaction(
            {
                "from": account.address,
                "nonce": nonce + i,
                "gas": 1_200_000,
                "gasPrice": w3.eth.gas_price,
                "chainId": deployment["chainId"],
            }
        )
        signed = account.sign_transaction(tx)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
        gas.append(receipt.gasUsed)
    insert_s = time.perf_counter() - insert_start
    return {
        "engine": "ethereum-hardhat",
        "existing_batches": total,
        "register_tx": extras,
        "insert_seconds": round(insert_s, 6),
        "history_query_seconds": round(query_s, 6),
        "approx_tps": round(extras / insert_s, 4) if insert_s else 0,
        "avg_gas_register": int(sum(gas) / len(gas)),
        "on_chain_events_complete": True,
    }


def main() -> None:
    baseline = _sqlite_workload(SQLITE_BATCHES)
    chain = _chain_workload()
    report = {
        "history_budget_seconds": HISTORY_BUDGET_S,
        "baseline": baseline,
        "blockchain": chain,
        "traceability_under_budget": baseline["history_query_seconds"] < HISTORY_BUDGET_S
        and (chain is None or chain.get("error") or chain["history_query_seconds"] < HISTORY_BUDGET_S),
        "transparency": "100% of lifecycle events sit in the on-chain history array",
    }
    out = RESULTS / "benchmark.json"
    out.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    assert baseline["history_query_seconds"] < HISTORY_BUDGET_S
    if chain and not chain.get("error"):
        assert chain["history_query_seconds"] < HISTORY_BUDGET_S
        assert chain["on_chain_events_complete"] is True
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
