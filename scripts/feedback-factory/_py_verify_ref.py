#!/usr/bin/env python3
"""Parity reference: run the REAL can_transition_to_verified deterministically.

The reference is time- and DB-dependent. We monkeypatch the processor's
`datetime` (so .now() returns the case's fixed `now`) and `run_prisma_query` (so
the version-anchored query returns the case's recentReportsSinceFix), then call
the actual, unmodified can_transition_to_verified. Emits JSON {case, result}.

Usage: python3 _py_verify_ref.py <processor_path> <corpus_path>
"""
import sys
import json
import importlib.util
import datetime as _dt


def load_processor(path):
    spec = importlib.util.spec_from_file_location("_feedback_processor_ref_vf", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def make_fake_datetime(fixed_now_iso):
    real = _dt.datetime

    class FakeDateTime:
        @staticmethod
        def now(tz=None):
            return real.fromisoformat(fixed_now_iso.replace('Z', '+00:00'))

        @staticmethod
        def fromisoformat(s):
            return real.fromisoformat(s)
    return FakeDateTime


def main():
    if len(sys.argv) != 3:
        print("usage: _py_verify_ref.py <processor_path> <corpus_path>", file=sys.stderr)
        sys.exit(2)
    processor_path, corpus_path = sys.argv[1], sys.argv[2]
    proc = load_processor(processor_path)
    with open(corpus_path, encoding="utf-8") as f:
        corpus = json.load(f)

    out = []
    for case in corpus["cases"]:
        proc.datetime = make_fake_datetime(case["now"])
        recent = case.get("recentReportsSinceFix", [])
        proc.run_prisma_query = lambda *a, **k: json.dumps(recent)
        result = proc.can_transition_to_verified(case["cluster"])
        out.append({"clusterId": case["cluster"]["clusterId"], "result": result})

    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
