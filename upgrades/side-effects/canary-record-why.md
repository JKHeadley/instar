# Side-Effects Review — A failing canary probe records what it observed

## Summary of the change

`profileUnenforceable()` wrote `failed: [probeName]` and nothing else; the probe's `detail` was
discarded, and the canary report that explains it (`<tmpDir>/canary-report-<nonce>.json`) is deleted
with the attempt tree. On 2026-10-21 the executor latched for 24h on `session-git-status` and the
cause was unrecoverable after the fact. Now: the probe's `detail` quotes the observed value, and the
latch records a bounded, scrubbed `failedDetail`. The verdict expression is unchanged.

## Decision-point inventory

- `evaluateSessionCanary()` `session-git-status` push — **modify** — `detail` only; `ok` untouched.
- `profileUnenforceable()` latch write — **modify** — adds `failedDetail`.

## 1. Over-block

Nothing new can be blocked. No probe is added, removed or re-expected, and the `ok` expression is
byte-identical (kept verbatim with a comment stating why). A test pins all three verdicts — missing
output still fails, a genuine git failure still fails, clean output still passes.

## 2. Under-block

Could richer recording weaken the gate? No: recording happens strictly AFTER the verdict, on the
failure path only. The 24h latch, its episode counting and its attention item are unchanged. The one
risk recording introduces is leakage, handled below.

## 3. Level-of-abstraction fit

The tempting fix was to stop treating a missing `outputs["9"]` as failure — but that changes a safety
verdict on an unconfirmed hypothesis, which is exactly what should not be rushed. Recording the
evidence is the prerequisite: it makes the next occurrence self-diagnosing so the verdict change can
be made on fact. Observability first, judgment second.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 4b. Judgment-point check (Judgment Within Floors standard)

None added. A string interpolation and a map over already-computed results.

## 5. Interactions

- **Shadowing / double-fire / races:** none; both sites run once per canary.
- **Feedback loops:** the latch record is read by `GET /feedback-factory/execute/status` and the
  attention item. Both gain detail; neither changes behaviour.

## 6. External surfaces

- **Persistent state:** `exec:profile_unenforceable` gains a `failedDetail` array (capped at 300
  chars per entry). Additive — existing readers of `failed` are unaffected.
- **Leakage:** a probe detail quotes sandbox output, so it goes through `scrubForStore` and withholds
  the text entirely if the scrub cannot vouch for it. The observed value is also clamped to 180 chars
  at the probe and 300 at the record.
- **Operator surface (Mobile-Complete Operator Actions):** no action added; the existing attention
  item becomes informative.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No new surface. The operator-visible change is a stop that explains itself.

## 7. Multi-machine posture (Cross-Machine Coherence)

None. The canary, the attempt tree and the executor meta are machine-local.

## 8. Rollback cost

Revert one commit. The latch returns to recording names only.

## Conclusion

Proceed. Purely additive recording on a failure path, with the verdict deliberately untouched, that
removes the forensics this exact latch already cost once.

## Second-pass review (if required)

Not required — Tier 1: a detail string and a map, plus tests.

## Evidence pointers

- The live incident: `profileUnenforceable: { until: …, episode: 1, failed: ["session-git-status"] }`
  and `canary: { ok: false, failed: ["session-git-status"] }` — one probe of ~21, with every must-fail
  refusal and every other session probe passing, so the confinement itself held.
- Two hypotheses were tested and REFUTED rather than shipped: the measured macOS noise
  (`git: error: couldn't create cache file … xcrun_db … Operation not permitted`, git exit 0) does not
  match the probe's regex and would pass — now pinned by a regression test; and
  `fatal: not a git repository` cannot apply because the workspace is cloned
  (FeedbackExecutorService createClone) before the canary runs.
- Tests: 45 pass. Three new ones pin the verdict on all three inputs and assert the detail
  distinguishes `<outputs["9"] absent>` from a quoted git failure.

## Class-Closure Declaration (display-only mirror)

The class is "durable records of a self-imposed stop that omit the evidence for it". The member fixed
here is the executor's 24h profile-unenforceable latch, and its sibling (`exec:deps`) already carries
its reason after the earlier work this week. Both stop-records now name a cause; a future stop-record
should be added with its reason from the start.
