#!/usr/bin/env python3
"""Parity reference: run the REAL cmd_cluster decision loop over a fixture.

Imports the reference processor without running its CLI main, then MONKEYPATCHES
its `run_prisma_query` so the two DB reads cmd_cluster does (unprocessed items,
then active clusters) return our fixture arrays instead of hitting a database.
cmd_cluster then runs its actual, unmodified decision loop and RETURNS the
results — which is exactly what the TS port must reproduce. cmd_cluster's own
stdout (FALSE-MERGE-GUARD logs + its json.dumps) is suppressed; we emit the
captured return value as clean JSON.

Usage: python3 _py_clustering_ref.py <processor_path> <fixture_path>
"""
import sys
import io
import json
import importlib.util
import contextlib


def load_processor(path):
    spec = importlib.util.spec_from_file_location("_feedback_processor_ref_cl", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    if len(sys.argv) != 3:
        print("usage: _py_clustering_ref.py <processor_path> <fixture_path>", file=sys.stderr)
        sys.exit(2)
    processor_path, fixture_path = sys.argv[1], sys.argv[2]
    proc = load_processor(processor_path)
    with open(fixture_path, encoding="utf-8") as f:
        fixture = json.load(f)

    # cmd_cluster calls run_prisma_query twice in order: items first, clusters second.
    responses = [json.dumps(fixture["items"]), json.dumps(fixture["clusters"])]
    call = {"n": 0}

    def fake_query(*_args, **_kwargs):
        i = call["n"]
        call["n"] += 1
        return responses[i] if i < len(responses) else "[]"

    proc.run_prisma_query = fake_query

    # Run the REAL loop; suppress cmd_cluster's stdout noise, capture its return.
    with contextlib.redirect_stdout(io.StringIO()):
        results = proc.cmd_cluster()

    sys.stdout.write(json.dumps(results if results is not None else [], ensure_ascii=False))


if __name__ == "__main__":
    main()
