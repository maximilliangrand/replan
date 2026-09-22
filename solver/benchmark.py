"""Reproduce synthetic planning evidence; nonzero exit on any violated invariant."""

import argparse
import hashlib
import json
import platform
import statistics
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import ortools

from checks import violations
from main import solve
from scenarios import VERSION, cases


def run(output):
    rows = []
    for case in cases():
        request = {key: case[key] for key in ("orders", "stock", "lanes")}
        results = {}
        for strategy in ("greedy", "optimized"):
            payload = {**request, "strategy": strategy}
            started = time.perf_counter()
            solution = solve(payload)
            elapsed = (time.perf_counter() - started) * 1000
            results[strategy] = {"solution": solution, "wallMs": round(elapsed, 3),
                                 "violations": violations(payload, solution)}
        rows.append({**case, "results": results})

    def aggregate(group):
        summary = {"cases": len(group), "optimizedWins": 0, "ties": 0, "optimizedLosses": 0}
        for row in group:
            greedy = row["results"]["greedy"]["solution"]
            optimized = row["results"]["optimized"]["solution"]
            a = (greedy["fulfilledPriority"], -greedy["totalCost"])
            b = (optimized["fulfilledPriority"], -optimized["totalCost"])
            summary["optimizedWins" if b > a else "optimizedLosses" if b < a else "ties"] += 1
        for strategy in ("greedy", "optimized"):
            results = [row["results"][strategy] for row in group]
            summary[strategy] = {
                "fulfilledPriority": sum(row["solution"]["fulfilledPriority"] for row in results),
                "fulfilledOrders": sum(len(row["solution"]["allocations"]) for row in results),
                "unfilledOrders": sum(len(row["solution"]["unfilled"]) for row in results),
                "transportCost": sum(row["solution"]["totalCost"] for row in results),
                "feasibilityViolations": sum(len(row["violations"]) for row in results),
                "meanWallMs": round(statistics.mean(row["wallMs"] for row in results), 3),
                "maxWallMs": max(row["wallMs"] for row in results),
                "provenOptimal": sum(row["solution"]["solverStatus"] == "OPTIMAL" for row in results),
            }
        return summary

    by_family = defaultdict(list)
    for row in rows:
        by_family[row["family"]].append(row)
    root = Path(__file__).resolve().parent
    report = {
        "schemaVersion": 1, "scenarioVersion": VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "environment": {"python": platform.python_version(), "ortools": ortools.__version__,
                        "platform": platform.platform()},
        "sourceSha256": {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
                         for name in ("main.py", "checks.py", "scenarios.py", "benchmark.py")},
        "scope": "Synthetic planning only. No recovery latency, production throughput, or real customer outcomes measured.",
        "overall": aggregate(rows),
        "bySplit": {split: aggregate([row for row in rows if row["split"] == split])
                    for split in ("development", "holdout")},
        "byFamily": {family: aggregate(group) for family, group in by_family.items()},
        "cases": rows,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(output), "overall": report["overall"],
                      "bySplit": report["bySplit"]}, indent=2))
    return int(any(report["overall"][strategy]["feasibilityViolations"] for strategy in ("greedy", "optimized")))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "evidence" / "planning.json")
    sys.exit(run(parser.parse_args().output))
