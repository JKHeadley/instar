# Side-Effects Review — Proactive default-account swap

**Version / slug:** `proactive-default-account-swap`
**Date:** `2026-07-22`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** independent security, integration, and decision reviewers — concurred

## Summary of the change

The existing proactive subscription swap now admits a refreshable untagged
session through its resolved default account, excludes sessions the existing
refresh funnel cannot route, prefers the lowest-utilization eligible target,
preserves structured refresh refusal codes, and boots on Slack-only installs.
Slack binding lookup gains the disk fallback already modeled by SessionRefresh.

## Decision-point inventory

- Proactive candidate admission — modified — requires a routable conversation
  binding and a valid effective source account.
- Proactive target preference — modified — lowest binding utilization wins
  after every existing eligibility/brake floor.
- Execute-time source revalidation — modified — re-resolves default-backed
  sessions before any refresh.
- In-flight work gate — pass-through — remains the authority over busy work.

## 1. Over-block

A temporarily unreadable binding registry excludes an otherwise refreshable
session for one tick. This is the safe direction for a destructive restart;
the next level-triggered tick retries after the registry recovers. A stale
higher-priority Telegram binding still wins over Slack, matching the refresh
funnel's established routing semantics.

## 2. Under-block

A readable but semantically stale disk binding can admit an attempt. The
authoritative refresh lookup repeats before kill and returns a concrete refusal;
failure backoff and the breaker bound repetition. The change does not attempt
to infer whether a still-present platform binding reflects operator intent.

## 3. Level-of-abstraction fit

Candidate admission stays in ProactiveSwapMonitor, target selection stays in
SwapAntiThrash, execution revalidation stays in QuotaAwareScheduler, and the
restart stays in SessionRefresh. SlackAdapter owns its own disk persistence.
No layer duplicates a credential store or becomes a parallel swap authority.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — structured binding and quota signals feed the existing deterministic
  proactive-swap authority.

The rules are enumerable resource and lifecycle invariants. No brittle content
detector or LLM judgment is introduced.

## 4b. Judgment-point check

No new competing-signals heuristic. “Freshest” is operator-defined as the
lowest valid binding-window utilization after the existing safety floors.

## 5. Interactions

- Legacy/dry-run behavior remains unchanged; the new default-session admission
  is in the live anti-thrash pipeline.
- SessionRefresh repeats binding lookup, so enumeration is signal-only.
- Source identity and target state are revalidated before refresh; no silent
  reselection occurs.
- Busy work still defers/drops through the existing gate.
- Successful untagged moves become tagged/pinned, so they do not mutate the
  default or create repeated default-session moves.

## 6. External surfaces

Users see their main interactive conversation move before quota exhaustion when
a fresh account is available. The existing swap ledger receives one optional
field. No new API, setting, URL, operator action, or credential store is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design under `physical-credential-locality`: OAuth homes,
platform bindings, tmux processes, and swap ledgers belong to the executing
host. Ledger rows already carry `machineId`; no notice or URL is added and no
durable state is stranded by topic transfer.

## 8. Rollback cost

Immediate rollback is disabling proactive swap. Code rollback is a revert and
patch release. The optional JSONL field needs no migration or repair.

## Conclusion

The review changed the implementation plan to revalidate default identity at
execution, use honest audit semantics, and cover Slack-only/disk-backed routing.
All three independent second-pass reviewers concurred. Clear to ship.

## Second-pass review

**Reviewers:** independent security, integration, and decision-completeness reviewers
**Independent read of the artifact: concur.** No remaining material lifecycle,
authority, integration, or convergence concern. The lifecycle reviewer first
found that an unresolved default source could pass revalidation; the code and a
null-source/no-refresh boundary test were added, then the reviewer concurred.

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence:
{ enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts,
howCaught: the monitor edge remains level-triggered and is bounded by non-overlap,
per-cycle/per-target caps, dwell, failure backoff, breaker, and work-deferral
ceiling; the ratchet requires those steady-state and settling brakes for this
self-triggered swap controller }`.

## Evidence pointers

- `tests/unit/swap-continuity-wiring.test.ts`
- `tests/unit/sessionRefresh-slack.test.ts`
- `tests/unit/proactive-swap-production-wiring.test.ts`
- `tests/e2e/swap-continuity-antithrash-lifecycle.test.ts`
