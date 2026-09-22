import copy
import itertools
import json
import random
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from checks import violations
from main import solve
from scenarios import cases, lane, order, stock


def brute_force_objective(request):
    """Tiny independent oracle; enumerates even invalid choices, then rejects them."""
    inventories = {(row["warehouse"], row["part"]): row["available"] for row in request["stock"]}
    best = (0, 0)
    for choices in itertools.product([None, *request["lanes"]], repeat=len(request["orders"])):
        used = {key: 0 for key in inventories}
        loads = {row["id"]: 0 for row in request["lanes"]}
        priority, cost, valid = 0, 0, True
        for demand, route in zip(request["orders"], choices):
            if route is None:
                continue
            key = (route["warehouse"], demand["part"])
            if (route["factory"] != demand["factory"] or route["hours"] > demand["deadlineHours"]
                    or key not in used):
                valid = False
                break
            used[key] += demand["quantity"]
            loads[route["id"]] += demand["quantity"]
            priority += demand["priority"]
            cost += route["unitCost"] * demand["quantity"]
        if valid and all(used[k] <= inventories[k] for k in used) and all(
                loads[route["id"]] <= route["capacity"] for route in request["lanes"]):
            best = max(best, (priority, -cost))
    return best


class SolverTests(unittest.TestCase):
    def request(self, **overrides):
        return {"orders": [order("o1", "f1")], "stock": [stock("w1", 2)],
                "lanes": [lane("l1", "w1", "f1")], "strategy": "optimized", **overrides}

    def test_optimized_preserves_scarce_source_for_restricted_order(self):
        request = {**next(cases()), "strategy": "optimized"}
        optimized = solve(request)
        greedy = solve({**request, "strategy": "greedy"})
        self.assertEqual(21, optimized["fulfilledPriority"])
        self.assertEqual(11, greedy["fulfilledPriority"])
        self.assertEqual("OPTIMAL", optimized["solverStatus"])
        self.assertEqual([], violations(request, optimized))

    def test_lane_capacity_is_shared_across_parts(self):
        request = self.request(
            orders=[order("rotor", "f1", priority=10), order("bearing", "f1", part="bearing", priority=9)],
            stock=[stock("w1", 1), stock("w1", 1, "bearing")],
            lanes=[lane("l1", "w1", "f1", capacity=1)],
        )
        for strategy in ("greedy", "optimized"):
            result = solve({**request, "strategy": strategy})
            self.assertEqual(["bearing"], result["unfilled"])
            self.assertEqual([], violations(request, result))

    def test_stock_is_shared_across_lanes(self):
        request = self.request(
            orders=[order("o1", "f1", priority=10), order("o2", "f2", priority=9)],
            stock=[stock("w1", 1)],
            lanes=[lane("l1", "w1", "f1"), lane("l2", "w1", "f2")],
        )
        result = solve(request)
        self.assertEqual(["o2"], result["unfilled"])
        self.assertEqual([], violations(request, result))

    def test_missing_stock_late_lane_and_partial_order_are_not_fulfilled(self):
        for request in (
            self.request(stock=[]),
            self.request(orders=[order("o1", "f1", deadline=3)]),
            self.request(orders=[order("o1", "f1", quantity=3)]),
            self.request(lanes=[lane("l1", "w1", "other")]),
        ):
            for strategy in ("greedy", "optimized"):
                result = solve({**request, "strategy": strategy})
                self.assertEqual([], result["allocations"])
                self.assertEqual(["o1"], result["unfilled"])
                self.assertEqual([], violations(request, result))

    def test_deadline_equality_is_feasible(self):
        result = solve(self.request(orders=[order("o1", "f1", deadline=4)]))
        self.assertEqual([], result["unfilled"])

    def test_cost_cannot_outweigh_one_unit_of_priority(self):
        request = self.request(
            orders=[order("high", "f1", priority=2), order("low", "f2", priority=1)],
            stock=[stock("w1", 1)],
            lanes=[lane("expensive", "w1", "f1", cost=1_000_000), lane("cheap", "w1", "f2", cost=0)],
        )
        result = solve(request)
        self.assertEqual(["low"], result["unfilled"])
        self.assertEqual(1_000_000, result["totalCost"])

    def test_total_priority_not_highest_individual_order_is_objective(self):
        request = self.request(
            orders=[order("large", "f1", quantity=2, priority=11),
                    order("small-a", "f1", priority=7), order("small-b", "f1", priority=7)],
        )
        result = solve(request)
        self.assertEqual(14, result["fulfilledPriority"])
        self.assertEqual(["large"], result["unfilled"])

    def test_zero_budget_is_honest_feasible_fallback(self):
        request = self.request()
        result = solve(request, time_limit=0)
        self.assertEqual("FALLBACK_GREEDY", result["solverStatus"])
        self.assertEqual([], violations(request, result))

    def test_empty_demand(self):
        result = solve(self.request(orders=[]))
        self.assertEqual([], result["allocations"])
        self.assertEqual([], result["unfilled"])
        self.assertEqual(0, result["totalCost"])

    def test_duplicate_records_and_non_integral_units_rejected(self):
        invalid = [
            self.request(stock=[stock("w1", 1), stock("w1", 2)]),
            self.request(lanes=[lane("l1", "w1", "f1"), lane("l1", "w1", "f2")]),
            self.request(orders=[order("o1", "f1"), order("o1", "f1")]),
            self.request(orders=[order("o1", "f1", quantity=1.5)]),
            self.request(orders=[order("o1", "f1", priority=True)]),
            self.request(lanes=[lane("l1", "w1", "f1", hours=float("nan"))]),
            self.request(lanes=[lane("l1", "w1", "f1", cost=-1)]),
            self.request(lanes=[lane("l1", "w1", "f1", cost=10 ** 1000)]),
            self.request(strategy="mystery"),
        ]
        for request in invalid:
            with self.assertRaises(ValueError):
                solve(request)

    def test_matches_exhaustive_independent_oracle(self):
        for seed in range(64):
            rng = random.Random(seed)
            request = self.request(
                orders=[order(f"o{i}", rng.choice(["f1", "f2"]), quantity=rng.randint(1, 3),
                              priority=rng.randint(1, 5), deadline=rng.randint(2, 5)) for i in range(3)],
                stock=[stock("w1", rng.randint(0, 5)), stock("w2", rng.randint(0, 5))],
                lanes=[lane(f"{w}-{f}", w, f, cost=rng.randint(0, 5), hours=rng.randint(2, 6),
                            capacity=rng.randint(0, 4)) for w in ("w1", "w2") for f in ("f1", "f2")],
            )
            result = solve(request)
            with self.subTest(seed=seed):
                self.assertEqual("OPTIMAL", result["solverStatus"])
                self.assertEqual(brute_force_objective(request), (result["fulfilledPriority"], -result["totalCost"]))
                self.assertEqual([], violations(request, result))

    def test_input_order_does_not_change_tied_solution(self):
        request = self.request(stock=[stock("w1", 2), stock("w2", 2)],
                               lanes=[lane("l1", "w1", "f1"), lane("l2", "w2", "f1")])
        first = solve(request)
        permuted = {**request, "lanes": list(reversed(request["lanes"])), "stock": list(reversed(request["stock"]))}
        self.assertEqual(first["allocations"], solve(permuted)["allocations"])

    def test_independent_validator_detects_corruption(self):
        request = self.request()
        result = solve(request)
        mutations = [
            ("quantity", 100), ("cost", 0), ("stockVersion", 99), ("part", "wrong"),
            ("mode", "wrong"), ("hours", 100), ("warehouse", "wrong"),
        ]
        for field, value in mutations:
            corrupted = copy.deepcopy(result)
            corrupted["allocations"][0][field] = value
            self.assertTrue(violations(request, corrupted), field)
        corrupted = copy.deepcopy(result)
        corrupted["allocations"].append(corrupted["allocations"][0])
        self.assertIn("order allocated more than once", violations(request, corrupted))

    def test_cli_success_and_invalid_input(self):
        path = Path(__file__).resolve().parents[1] / "main.py"
        successful = subprocess.run([sys.executable, str(path)], input=json.dumps(self.request()),
                                    text=True, capture_output=True, check=True)
        self.assertEqual([], violations(self.request(), json.loads(successful.stdout)))
        self.assertEqual("", successful.stderr)
        failed = subprocess.run([sys.executable, str(path)], input='{"strategy": "invalid"}',
                                text=True, capture_output=True)
        self.assertEqual(1, failed.returncode)
        self.assertEqual("", failed.stdout)
        self.assertIn("error", json.loads(failed.stderr))


if __name__ == "__main__":
    unittest.main()
