# Round 1 — Standards-Conformance Gate (code-backed, signal-only)
- standardsChecked: 22, degraded: false
- FINDING [possible-violation] **Framework-Agnostic — and Framework-Optimizing**:
  The spec establishes a fixed provider preference chain (Codex first, Claude last)
  for internal components, which plausibly privileges one execution framework.
  → Resolution to fold in: this is an operator-DIRECTED default (Justin's explicit
    directive), fully overridable (§4.3), active-filtered, and the mechanism treats
    all frameworks uniformly (no framework-specific code path). Document why the
    opinionated default is framework-agnostic-compatible (a chosen default ≠ a lock-in).
