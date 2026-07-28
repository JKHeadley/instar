#!/usr/bin/env python3
"""Parity reference: compute fingerprints using the REAL feedback-processor.py.

Imports the reference processor (the-portal/.claude/scripts/feedback-processor.py)
WITHOUT running its CLI main (it has an `if __name__ == '__main__'` guard; loading
under a different module name keeps that dormant), then calls its actual
compute_fingerprint over the shared corpus. Emits JSON to stdout so the Node
harness can diff the TS port against this ground truth.

Usage: python3 _py_fingerprint_ref.py <processor_path> <corpus_path>
"""
import sys
import json
import importlib.util


def load_processor(path):
    spec = importlib.util.spec_from_file_location("_feedback_processor_ref", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # safe: top-level is imports + constants + defs; DB work is inside cmd_* only
    return mod


def main():
    if len(sys.argv) != 3:
        print("usage: _py_fingerprint_ref.py <processor_path> <corpus_path>", file=sys.stderr)
        sys.exit(2)
    processor_path, corpus_path = sys.argv[1], sys.argv[2]
    proc = load_processor(processor_path)
    with open(corpus_path, encoding="utf-8") as f:
        corpus = json.load(f)
    out = []
    for case in corpus["cases"]:
        t = case["type"]
        title = case["title"]
        component = case.get("component", "")
        fp = proc.compute_fingerprint(t, title, component)
        out.append({"type": t, "title": title, "component": component, "fp": fp})
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
