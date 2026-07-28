# Side-effects review: Work Queue v2 scoring

- Rebalances deterministic scoring so explicit priority dominates the bounded age term.
- Adds named stale threshold, per-day discount, and discount cap; ageDays remains an explicit input with no clock or randomness.
- Unit tests cover fresh-high versus old-medium and fresh-critical versus untouched three-month critical.
- PR proof uses only synthetic backlog items; no operator backlog data is copied into the repository.
