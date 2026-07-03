# Model-registry freshness guard (CI lint, ships non-gating)

<!-- internal-only -->

## What Changed

Repo-internal CI tooling only — a deterministic lint + manifest + unit test that
flags when per-provider `capable/latest/frontier` model pins go stale. Ships in
report mode (non-gating); changes no model id and no runtime path. No user-facing
or agent-facing behavior change.
