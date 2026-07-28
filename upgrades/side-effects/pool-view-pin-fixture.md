# Side-effects review

- Runtime behavior is unchanged; only an integration-test fixture and its matching assertion changed.
- The PIN remains deterministic so failures are reproducible.
- The higher-entropy value sharply reduces accidental substring collisions in serialized envelopes.
- The PIN-gated view coverage continues to use the same fixture through the shared constant.
- Second pass: focused suite green; no additional seams identified.
