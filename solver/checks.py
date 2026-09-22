"""Independent result checks: never imports solver candidate or constraint code."""

from collections import Counter


def violations(request, result):
    errors = []
    orders = {item["id"]: item for item in request["orders"]}
    lanes = {item["id"]: item for item in request["lanes"]}
    stock = {(item["warehouse"], item["part"]): item for item in request["stock"]}
    used_stock, used_lanes, fulfilled = Counter(), Counter(), Counter()
    actual_cost = 0
    for allocation in result["allocations"]:
        order = orders.get(allocation["orderId"])
        lane = lanes.get(allocation["laneId"])
        if order is None or lane is None:
            errors.append("unknown order or lane")
            continue
        fulfilled[order["id"]] += 1
        key = (allocation["warehouse"], allocation["part"])
        inventory = stock.get(key)
        if inventory is None:
            errors.append("stock record missing")
        elif allocation["stockVersion"] != inventory["version"]:
            errors.append("stock version differs from observation")
        if allocation["quantity"] != order["quantity"]:
            errors.append("order must be fulfilled in full")
        if allocation["part"] != order["part"]:
            errors.append("wrong part")
        if allocation["warehouse"] != lane["warehouse"] or order["factory"] != lane["factory"]:
            errors.append("lane endpoints do not match")
        if allocation["hours"] != lane["hours"] or allocation["mode"] != lane["mode"]:
            errors.append("lane evidence changed")
        if lane["hours"] > order["deadlineHours"]:
            errors.append("deadline missed")
        actual_cost += order["quantity"] * lane["unitCost"]
        if allocation["cost"] != order["quantity"] * lane["unitCost"]:
            errors.append("incorrect allocation cost")
        used_stock[key] += allocation["quantity"]
        used_lanes[lane["id"]] += allocation["quantity"]
    if any(count > 1 for count in fulfilled.values()):
        errors.append("order allocated more than once")
    for key, quantity in used_stock.items():
        if key in stock and quantity > stock[key]["available"]:
            errors.append("warehouse inventory exceeded")
    for key, quantity in used_lanes.items():
        if quantity > lanes[key]["capacity"]:
            errors.append("lane capacity exceeded")
    if sorted(result["unfilled"]) != sorted(set(orders) - set(fulfilled)):
        errors.append("unfilled list is not the exact complement of allocated orders")
    if result["totalCost"] != actual_cost:
        errors.append("incorrect total cost")
    if result["fulfilledPriority"] != sum(orders[key]["priority"] for key in fulfilled):
        errors.append("incorrect fulfilled priority")
    return errors
