#!/usr/bin/env python3
"""Parity reference: Jaccard title similarity from the REAL feedback-processor.py.

Imports the reference processor without running its CLI main (same approach as
_py_fingerprint_ref.py) and calls its actual `_jaccard_similarity` over a corpus
of title PAIRS. Emits JSON {a, b, sim} so the Node harness can diff the TS port.

Usage: python3 _py_similarity_ref.py <processor_path> <pairs_corpus_path>
"""
import sys
import json
import importlib.util


def load_processor(path):
    spec = importlib.util.spec_from_file_location("_feedback_processor_ref_sim", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    if len(sys.argv) != 3:
        print("usage: _py_similarity_ref.py <processor_path> <pairs_corpus_path>", file=sys.stderr)
        sys.exit(2)
    processor_path, corpus_path = sys.argv[1], sys.argv[2]
    proc = load_processor(processor_path)
    with open(corpus_path, encoding="utf-8") as f:
        corpus = json.load(f)
    out = []
    for pair in corpus["pairs"]:
        a, b = pair["a"], pair["b"]
        sim = proc._jaccard_similarity(a, b)
        out.append({"a": a, "b": b, "sim": repr(sim)})  # repr() = full-precision float string
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
