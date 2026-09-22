"""One JSON request on stdin; one Solution on stdout. No external side effects."""

import json
import math
import sys
import time
from collections import defaultdict

from ortools.sat.python import cp_model

MAX_VALUE = 1_000_000  # Keeps all objective and constraint sums within int64.
MAX_OPTIONS = 20_000  # Bound model construction as well as search for the local MVP.
SOLVE_SECONDS = 5.0


def validate_input(payload):
    if not isinstance(payload, dict):
        raise ValueError("request must be an object")
    if payload.get("strategy") not in ("greedy", "optimized"):
        raise ValueError("strategy must be greedy or optimized")
    limits = {"orders": 500, "stock": 2000, "lanes": 2000}
    for name, limit in limits.items():
        items = payload.get(name)
        if not isinstance(items, list) or len(items) > limit:
            raise ValueError(f"{name} must be an array with at most {limit} entries")
        if any(not isinstance(item, dict) for item in items):
            raise ValueError(f"{name} entries must be objects")

    def text(item, field):
        value = item.get(field)
        if not isinstance(value, str) or not value.strip() or len(value) > 256:
            raise ValueError(f"{field} must be a nonempty string of at most 256 characters")

    def number(item, field, minimum=0, integer=True, maximum=MAX_VALUE):
        value = item.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{field} must be a number")
        if not minimum <= value <= maximum or not math.isfinite(value):
            raise ValueError(f"{field} must be between {minimum} and {maximum}")
        if integer and not isinstance(value, int):
            raise ValueError(f"{field} must be an integer")

    for order in payload["orders"]:
        for field in ("id", "factory", "part"):
            text(order, field)
        number(order, "quantity", 1)
        number(order, "priority", 1)
        number(order, "deadlineHours", integer=False)
    for stock in payload["stock"]:
        for field in ("warehouse", "part"):
            text(stock, field)
        number(stock, "available")
        # Versions are concurrency tokens, never objective coefficients.
        number(stock, "version", maximum=2_000_000_000)
    for lane in payload["lanes"]:
        for field in ("id", "warehouse", "factory", "mode"):
            text(lane, field)
        number(lane, "hours", integer=False)
        number(lane, "unitCost")
        number(lane, "capacity")
    for name in ("orders", "lanes"):
        ids = [item["id"] for item in payload[name]]
        if len(ids) != len(set(ids)):
            raise ValueError(f"duplicate {name} id")
    keys = [(item["warehouse"], item["part"]) for item in payload["stock"]]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate stock warehouse/part; provide one authoritative record")


def options_for(payload):
    """Feasible individual transfers; both strategies enforce the same constraints."""
    stock = {(row["warehouse"], row["part"]): row for row in payload["stock"]}
    result = []
    for order in sorted(payload["orders"], key=lambda row: row["id"]):
        for lane in sorted(payload["lanes"], key=lambda row: row["id"]):
            row = stock.get((lane["warehouse"], order["part"]))
            if (lane["factory"] != order["factory"] or row is None
                    or lane["hours"] > order["deadlineHours"]
                    or min(row["available"], lane["capacity"]) < order["quantity"]):
                continue
            result.append({
                "orderId": order["id"], "warehouse": lane["warehouse"],
                "part": order["part"], "quantity": order["quantity"],
                "laneId": lane["id"], "mode": lane["mode"], "hours": lane["hours"],
                "cost": order["quantity"] * lane["unitCost"],
                "stockVersion": row["version"],
            })
            if len(result) > MAX_OPTIONS:
                raise ValueError(f"more than {MAX_OPTIONS} feasible transfers; narrow the planning batch")
    return result


def greedy_indices(payload, options):
    remaining = {(row["warehouse"], row["part"]): row["available"] for row in payload["stock"]}
    capacity = {lane["id"]: lane["capacity"] for lane in payload["lanes"]}
    selected = []
    by_order = defaultdict(list)
    for index, option in enumerate(options):
        by_order[option["orderId"]].append(index)
    for order in sorted(payload["orders"], key=lambda row: (-row["priority"], row["deadlineHours"], row["id"])):
        ranked = sorted(by_order[order["id"]], key=lambda i: (
            options[i]["cost"], options[i]["hours"], options[i]["warehouse"], options[i]["laneId"],
        ))
        for index in ranked:
            option = options[index]
            key = (option["warehouse"], option["part"])
            if min(remaining[key], capacity[option["laneId"]]) < option["quantity"]:
                continue
            selected.append(index)
            remaining[key] -= option["quantity"]
            capacity[option["laneId"]] -= option["quantity"]
            break
    return selected


def optimize(payload, options, budget):
    if not options:
        return [], "OPTIMAL", "No full order has a feasible transfer."
    deadline = time.monotonic() + budget
    model = cp_model.CpModel()
    variables = [model.new_bool_var(f"transfer_{i}") for i in range(len(options))]
    orders = {row["id"]: row for row in payload["orders"]}
    by_order, by_stock, by_lane = defaultdict(list), defaultdict(list), defaultdict(list)
    for index, option in enumerate(options):
        by_order[option["orderId"]].append(index)
        by_stock[option["warehouse"], option["part"]].append(index)
        by_lane[option["laneId"]].append(index)
    for indices in by_order.values():
        model.add_at_most_one(variables[i] for i in indices)
    for stock in payload["stock"]:
        indices = by_stock[stock["warehouse"], stock["part"]]
        model.add(sum(options[i]["quantity"] * variables[i] for i in indices) <= stock["available"])
    for lane in payload["lanes"]:
        model.add(sum(options[i]["quantity"] * variables[i] for i in by_lane[lane["id"]]) <= lane["capacity"])
    priority = sum(orders[option["orderId"]]["priority"] * variables[i] for i, option in enumerate(options))
    cost = sum(option["cost"] * variables[i] for i, option in enumerate(options))
    fallback = greedy_indices(payload, options)
    fallback_set = set(fallback)
    for i, variable in enumerate(variables):
        model.add_hint(variable, int(i in fallback_set))
    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 0
    solver.parameters.max_time_in_seconds = max(0.0, deadline - time.monotonic())
    model.maximize(priority)
    status = solver.solve(model)
    if status == cp_model.MODEL_INVALID:
        raise RuntimeError(f"invalid optimization model: {model.validate()}")
    if status == cp_model.INFEASIBLE:
        raise RuntimeError("optimization model unexpectedly rejected the empty allocation")
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return fallback, "FALLBACK_GREEDY", "Solver returned no incumbent within its budget; using a feasible greedy plan, with no optimality claim."
    selected = [i for i, var in enumerate(variables) if solver.value(var)]
    if status != cp_model.OPTIMAL:
        return selected, "FEASIBLE", "Feasible plan; priority optimality was not proven before the time limit. Cost was not optimized."
    best_priority = solver.value(priority)
    model.add(priority == best_priority)
    model.minimize(cost)
    model.clear_hints()
    selected_set = set(selected)
    for i, variable in enumerate(variables):
        model.add_hint(variable, int(i in selected_set))
    solver.parameters.max_time_in_seconds = max(0.0, deadline - time.monotonic())
    status = solver.solve(model)
    if status == cp_model.MODEL_INVALID:
        raise RuntimeError(f"invalid optimization model: {model.validate()}")
    if status == cp_model.INFEASIBLE:
        raise RuntimeError("cost optimization unexpectedly rejected the priority incumbent")
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        selected = [i for i, var in enumerate(variables) if solver.value(var)]
    if status == cp_model.OPTIMAL:
        return selected, "OPTIMAL", "Maximum fulfilled priority, then minimum transport cost, proven for this snapshot and these constraints."
    return selected, "FEASIBLE", "Maximum priority proven; minimum cost not proven before the time limit."


def solve(payload, *, time_limit=SOLVE_SECONDS):
    started = time.perf_counter()
    validate_input(payload)
    if not math.isfinite(time_limit) or time_limit < 0:
        raise ValueError("time_limit must be finite and nonnegative")
    options = options_for(payload)
    if payload["strategy"] == "greedy":
        selected = greedy_indices(payload, options)
        status, explanation = "HEURISTIC", "Priority-first greedy: choose the cheapest feasible transfer for each order; no global optimality claim."
    else:
        selected, status, explanation = optimize(payload, options, time_limit)
    orders = {row["id"]: row for row in payload["orders"]}
    allocations = sorted((options[i] for i in selected), key=lambda option: (
        -orders[option["orderId"]]["priority"], orders[option["orderId"]]["deadlineHours"], option["orderId"],
    ))
    fulfilled = {option["orderId"] for option in allocations}
    return {
        "allocations": allocations,
        "unfilled": sorted(set(orders) - fulfilled),
        "totalCost": sum(option["cost"] for option in allocations),
        "fulfilledPriority": sum(orders[order_id]["priority"] for order_id in fulfilled),
        "solverStatus": status,
        "solveMs": round((time.perf_counter() - started) * 1000, 3),
        "explanation": explanation,
    }


def main():
    try:
        payload = json.load(sys.stdin)
        result = solve(payload)
    except (ValueError, TypeError, KeyError, RuntimeError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 1
    print(json.dumps(result, allow_nan=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
