# Side-effects review: automated messaging template fingerprint observe-only

- Adds pure volatile-span normalization and SHA-256 fingerprinting for automated message templates.
- Records the fingerprint and tone-gate verdict in existing JudgmentProvenanceLog rows; no body content, cache, skip, or behavior change is introduced.
- Unit tests prove real canary-shaped ids collide and genuinely different templates remain distinct.
