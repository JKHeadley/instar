# RETRACTION — the constitution's "false claim" is not false

**Retracts:** my window-7 finding that `Cross-Store Coherence Is an Invariant` asserts machinery that
does not exist. **Reported to the operator twice and sanctioned as a correction PR. It is wrong.**

## What I claimed

`scripts/standards-coverage.mjs` reported:

```
FALSE CLAIM — "Cross-Store Coherence Is an Invariant" asserts running machinery
("A scheduled coherence audit", "on every machine daily", "walks the list")
but names no resolvable guard.
```

I relayed that as *"the constitution contains a false claim — no such thing exists."*

## What is actually true

The machinery exists **and ran four hours ago**:

| evidence | result |
|---|---|
| job file, this machine | `.instar/jobs/user/coherence-audit.md` (dated Jul 1, matching the postmortem) |
| job file, the laptop | present — so *"on every machine"* holds |
| scheduler registration | `coherence-audit`, `enabled: true`, `schedule: "20 9 * * *"` — daily |
| activity-log events | **40**, first `2026-07-02T00:40Z`, **last `2026-08-04T23:20Z`** |
| event breakdown | 32 `job_triggered` · 3 `job_skipped` · 2 `job_error` · **3 `job_alert_delivered`** |

**Every clause of the standard's claim is satisfied.** A scheduled coherence audit does walk the list,
on every machine, daily, and it has delivered alerts.

## Why the script said otherwise — and why this is the better finding

The script's check:

| | |
|---|---|
| **measures** | the prose asserts running machinery **and** names no *resolvable guard ref* |
| **certifies** | "this standard makes a FALSE CLAIM" |
| **the gap** | machinery implemented as a **scheduled job** (`jobs/user/*.md`) is not a guard artifact, so it is invisible to the resolver |

**A standard whose enforcement is a job gets called a liar.**

> **This is instance #8 of the measure-vs-certify defect — found inside the instrument I used to find
> the other seven.** The synthesis is not weakened by this; it is confirmed by it, in the strongest way
> available: the pattern predicted that my own tooling would carry the same flaw, and it does.

**Consequence:** `falseClaimCount` is not a reliable metric, and the `false-claims <= 1` floor is
calibrated against a number that may be entirely composed of job-enforced standards. Any standard the
script flags must be checked against jobs and runtime evidence before being called false.

## How I caught it — and how nearly I didn't

Only because I read the entry before editing it, and noticed its `Applied through` section was **more
honest than its `In practice`** — it already says *"deployed on the originating fleet; the generalized
job template is the tracked follow-on."* That mismatch prompted a check rather than an edit.

**The sanctioned action was a correction PR against the constitution.** Had I executed the ruling
directly instead of verifying its premise, I would have edited a true statement out of the constitution
on the authority of a mis-scoped script — and the edit would have carried an operator's sanction,
making it far harder to reverse later.

**The near-miss chain, which is the real lesson:** a mis-scoped check produced a confident verdict → I
relayed the verdict as a finding → the finding was escalated → action was sanctioned on it. **Four
steps, and the only thing that stopped it was reading the primary source at the last one.**

*(One residual, genuinely open and much smaller: whether the standard's `In practice` should soften
"on every machine daily" given its own `Applied through` calls the generalized template a tracked
follow-on. That is a wording question about scope, not a false claim, and it is the operator's to
judge — not something I should quietly fix while retracting.)*
