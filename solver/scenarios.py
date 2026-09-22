"""Frozen synthetic benchmark families; none represent observed customer data."""

import random

VERSION = "1"


def order(key, factory, part="rotor", quantity=1, priority=10, deadline=12):
    return {"id": key, "factory": factory, "part": part, "quantity": quantity,
            "priority": priority, "deadlineHours": deadline}


def lane(key, warehouse, factory, cost=10, hours=4, capacity=10):
    return {"id": key, "warehouse": warehouse, "factory": factory, "mode": "road",
            "unitCost": cost, "hours": hours, "capacity": capacity}


def stock(warehouse, quantity, part="rotor"):
    return {"warehouse": warehouse, "part": part, "available": quantity, "version": 1}


def cases():
    yield {"id": "development-flexibility", "split": "development", "family": "flexible-source",
           "orders": [order("flexible", "f1", priority=11), order("restricted", "f2")],
           "stock": [stock("near", 1), stock("far", 1)],
           "lanes": [lane("near-f1", "near", "f1", cost=5), lane("near-f2", "near", "f2", cost=5),
                     lane("far-f1", "far", "f1", cost=8)]}
    yield {"id": "development-abundant", "split": "development", "family": "abundant",
           "orders": [order("o1", "f1"), order("o2", "f2")],
           "stock": [stock("w1", 10), stock("w2", 10)],
           "lanes": [lane(f"{w}-{f}", w, f, cost=5 if w == "w1" else 8)
                     for w in ("w1", "w2") for f in ("f1", "f2")]}
    yield {"id": "development-no-feasible-route", "split": "development", "family": "unfulfillable",
           "orders": [order("o1", "f1", deadline=1), order("o2", "f2", quantity=2)],
           "stock": [stock("w1", 1)],
           "lanes": [lane("l1", "w1", "f1"), lane("l2", "w1", "f2")]}

    # These distinct families exercise shared capacity across parts, all-or-nothing
    # packing, and varied sparse networks; solver code has no family-specific rules.
    for seed in range(8):
        rng = random.Random(seed)
        quantity = rng.randint(2, 5)
        yield {"id": f"holdout-shared-lane-{seed}", "split": "holdout", "family": "shared-lane-multiple-parts",
               "orders": [order("rotor", "f1", quantity=quantity, priority=10),
                          order("bearing", "f1", part="bearing", quantity=quantity, priority=9)],
               "stock": [stock("w1", quantity), stock("w1", quantity, "bearing"), stock("w2", quantity)],
               "lanes": [lane("shared", "w1", "f1", capacity=quantity, cost=5),
                         lane("alternate", "w2", "f1", capacity=quantity, cost=9)]}
        yield {"id": f"holdout-packing-{seed}", "split": "holdout", "family": "indivisible-demand",
               "orders": [order("large", "f1", quantity=2 * quantity, priority=11),
                          order("small-a", "f1", quantity=quantity, priority=7),
                          order("small-b", "f1", quantity=quantity, priority=7)],
               "stock": [stock("w1", 2 * quantity)],
               "lanes": [lane("l1", "w1", "f1", capacity=2 * quantity)]}
        factories = ["f1", "f2", "f3"]
        warehouses = ["w1", "w2", "w3"]
        parts = ["rotor", "bearing"]
        yield {"id": f"holdout-sparse-{seed}", "split": "holdout", "family": "sparse-network",
               "orders": [order(f"o{i}", rng.choice(factories), rng.choice(parts),
                                quantity=rng.randint(1, 4), priority=rng.randint(1, 15),
                                deadline=rng.choice([2, 6, 12])) for i in range(8)],
               "stock": [stock(w, rng.randint(0, 8), part) for w in warehouses for part in parts],
               "lanes": [lane(f"{w}-{f}", w, f, cost=rng.randint(2, 25),
                              hours=rng.choice([3, 5, 10]), capacity=rng.randint(1, 8))
                         for w in warehouses for f in factories if rng.random() > 0.2]}
