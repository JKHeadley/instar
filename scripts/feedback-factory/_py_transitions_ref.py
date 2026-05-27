#!/usr/bin/env python3
"""Parity reference: lifecycle transitions from the REAL feedback-processor.py.

Imports the reference processor without running its CLI main and calls its actual
`can_transition` + `detect_cycling` over the shared corpus. Emits JSON so the Node
harness can diff the TS port (both the allowed decision AND the reason string).

Usage: python3 _py_transitions_ref.py <processor_path> <corpus_path>
"""
import sys
import json
import importlib.util


def load_processor(path):
    spec = importlib.util.spec_from_file_location("_feedback_processor_ref_tx", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    if len(sys.argv) != 3:
        print("usage: _py_transitions_ref.py <processor_path> <corpus_path>", file=sys.stderr)
        sys.exit(2)
    processor_path, corpus_path = sys.argv[1], sys.argv[2]
    proc = load_processor(processor_path)
    with open(corpus_path, encoding="utf-8") as f:
        corpus = json.load(f)

    tx_out = []
    for case in corpus["transitions"]:
        allowed, reason = proc.can_transition(
            case["current"],
            case["new"],
            case.get("justification"),
            case.get("context"),
        )
        tx_out.append({"case": case, "allowed": allowed, "reason": reason})

    cyc_out = []
    for cluster in corpus["cycling"]:
        cyc_out.append({"cluster": cluster, "cycling": proc.detect_cycling(cluster)})

    sys.stdout.write(json.dumps({"transitions": tx_out, "cycling": cyc_out}, ensure_ascii=False))


if __name__ == "__main__":
    main()
