# Side-Effects Review — Jev signal-layer shadow (dark, measure-only)

**Version / slug:** `jev-signal-shadow`
**Date:** `2026-09-21`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see appended section)`

## Summary of the change

Adds `JevSignalShadow` (`src/core/JevSignalShadow.ts`), a research instrument that
sends each message reaching the outbound tone gate to TypeSafe's Jev model with
seven yes/no questions — one per deterministic B1–B7 artefact detector — and logs a
content-free comparison row to `logs/jev-signal-shadow.jsonl`. `MessagingToneGate`
gains `setSignalShadow()` and calls `observe(text)` once at the top of `review()`
inside a try/catch; `observe()` is synchronous, never throws, and never awaited.
`server.ts` constructs it after the tone gate with a live config read, the vault key
`typesafe_api_key`, and the feature-metrics recorder. `PostUpdateMigrator.migrateConfig`
adds the dark default `intelligence.jevSignalShadow` block (enabled:false,
soakEndsAt:null). `scripts/jev-shadow-report.mjs` reads the log into per-rule
confusion matrices plus coverage.

Spec: `docs/specs/jev-signal-layer-shadow.md` (converged; approved by Justin
2026-09-21, including the soak egress approval).

## Decision-point inventory

- *(none)* — the shadow writes an audit row and nothing reads it on any decision
  path. `MessagingToneGate.review()` gains one guarded fire-and-forget call before
  its existing logic; the verdict computation is untouched.

---

## 1. Over-block

No issue identified. The shadow holds no authority and cannot refuse, delay or alter
a message. Proven by the integration test that runs the real gate against a Jev stub
that never settles: the verdict returns while the call is still pending.

## 2. Under-block

Not applicable — it blocks nothing. What it can MISS as an instrument is recorded,
not hidden: every candidate that is not compared produces a row with a closed-enum
reason (timeout, http-error, oversize, skipped-concurrent, skipped-sample,
model-mismatch, disabled-no-key, soak-expired), so the report's coverage figure is
honest. Standing conditions (no key, soak expired) write one row per process, not
one per message.

## 3. Level-of-abstraction fit

The tone gate is the one place every outbound message already passes with its
detector signals available, so observing there is the correct layer. The shadow
re-runs `detectGateSignals` itself (cheap, deterministic) rather than threading
state out of the gate, keeping zero shared state with the decision path.

## 4. Signal vs authority compliance

Pure signal, and not even a consumed one yet: the output is a log for a later human
decision. Per `docs/signal-vs-authority.md`, adding an unconsumed detector is the
safest possible shape. Graduation into any authority is explicitly a separate spec.

## 5. Interactions

- **Gate latency:** synchronous cost per candidate is one config read, one sha256
  (over at most the first 1 MB), one small append for any not-compared row
  (skipped-sample, oversize, skipped-concurrent), and (when dispatching) one
  detector pass and one JSON body. The vault key — a lookup that can block on a
  macOS keychain subprocess — is read at construction (boot); after a miss or a 401/403 it is re-read at most once per 10 minutes, so a
  revoked key costs one lookup per 10 minutes, not one per message. That rate-limited
  re-read does run synchronously on the gate path, and only while the shadow is
  enabled with a missing or revoked key. A key added to
  the vault later is picked up within 10 minutes, no restart.
  Network runs detached. Single-flight: at most one call in flight per process;
  overflow is a row, never a queue, so a slow vendor cannot build memory pressure.
- **Feature metrics:** each call records under feature `jev-signal-shadow`,
  framework `typesafe-api`, so token spend appears in `/metrics/features` beside
  other LLM features. No double-counting with the gate's own LLM call.
- **Credential wall:** unaffected; the shadow sees the same text the gate sees and
  sends it only to TypeSafe, and only while enabled.
- **Tests:** the shadow is optional (`signalShadow?`); every existing tone-gate test
  constructs the gate without one and is unchanged.

## 6. External surfaces

While ENABLED, message text reaching the gate is sent to one more third party
(TypeSafe, under the MCA accepted 2026-09-20). This is the egress the operator
approved explicitly in the spec (`soak-egress-approved: true`). Ships DISABLED; the
14-day bound is mechanical (`soakEndsAt`, checked per candidate, survives restarts).
Log rows never contain message text: sha256, byte length, detector kinds, Jev
probabilities, reason enum. A vendor error body is never recorded. The vault key is
read once and cached, re-read only after a 401/403, and never logged.

## 7. Multi-machine posture

Machine-local BY DESIGN. The log is this machine's observation of its own gate
traffic (observation locality). Config is ordinary per-machine config; the soak is
enabled on this dev agent only. No user-facing notices, no durable state that must
follow a topic, no URLs.

## 8. Rollback cost

Operational: set `intelligence.jevSignalShadow.enabled` false — read live per
candidate, no restart. Code: revert the commit; the config block left behind is
inert (nothing else reads it). The log is inert data.

## Second-pass review

**Reviewer:** independent reviewer subagent
**Verdict:** Concern raised: the vault key read runs synchronously on the gate path, and after a 401/403 it runs again on every dispatched candidate.

The concern:
- `observeInner()` calls `readKey()` inline, inside `MessagingToneGate.review()`, whenever `cachedKey === undefined`. In production `readKey` builds a `SecretStore` and calls `.get()`. On macOS that resolves the master key with `execFileSync('security', …, { timeout: 5000 })`, which is a synchronous subprocess that blocks the whole event loop. It can take up to 5 s per lookup, and the resolution order may try two keychain accounts. This cost lands on the first enabled candidate.
- After a 401/403, `dispatch` resets `cachedKey = undefined`. The next candidate then re-reads the key synchronously. The key read happens before the single-flight check, so a revoked key that stays in the vault leads to one blocking keychain spawn per dispatched candidate, for the whole soak. The spec forbids exactly this ("never a per-call decrypt on the event loop", "never a gate delay").
- Suggested fix: resolve the key off the message path. Either read it inside the detached `dispatch()`, or warm it at construction or on a `setImmediate`. Also latch an auth failure, for example to a `disabled-no-key`-class status with a bounded re-read interval, instead of re-reading on every candidate.

Smaller accuracy points for this artifact (not blocking):
- §5 "Interactions / Gate latency" lists the synchronous cost as config read, sha256, detector pass and JSON body. It leaves out two synchronous costs: the keychain read above, and the `mkdirSync` + `appendFileSync` for the `not-compared` rows (`skipped-sample`, `oversize`, `skipped-concurrent`, status rows). Those rows are written on the gate path.
- The sha256 is computed over the full text before the 1 MB size guard, so hashing an oversize message is not bounded by the guard.
- A missing key is cached as `null` for the life of the process, so a key added to the vault after enabling needs a restart. That is consistent with "read once", but the operator should be told.
- The e2e test wires the real gate to a shadow built in the test. It does not exercise the `server.ts` construction: the live `intelligence.jevSignalShadow` read, the `SecretStore` key read and the `logs/` path. The tone-gate lifecycle standard asks for a test of the production initialization path.

What I checked and found sound:
- Verdict isolation: `observe()` is wrapped in try/catch both in the module and at the call site. `dispatch` is async and chained with `.catch().finally()`, so no promise rejection goes unhandled. `review()` never awaits the dispatch. The abort timer is bounded by `timeoutMs` and cleared in `finally`, so it cannot keep the process alive past that bound.
- Single-flight: `inFlight` is set only after every early return, and it is reset in `.finally()` on every path. `write()` and the metrics call each swallow their own errors, so neither can skip the reset.
- Leakage: rows carry only the sha256, byte length, detector kinds, probabilities, model and a closed-enum reason. The vendor response body is never read on a non-OK status. The API key appears only in the request header and never reaches a row, a metric or the console. The construction-failure log line prints only the error message.
- Disabled means inert: `enabled !== true` returns before hashing, any key read, any network call or any row. The integration and e2e tests assert zero rows.
- The soak bound is mechanical: a missing, unparseable or past `soakEndsAt` is inert and checked on every candidate. The block is read from live config, so the bound survives restarts. It writes one status row per process.
- Spec coverage: the closed reason set is complete and each reason has a test. Model pinning and `model-mismatch` exclusion, the migration (existence-checked, idempotent), the feature-metrics metering and the report script (dedupe by hash, per-rule confusion matrices, coverage, insufficient-evidence under 20 positives) are all present. All 26 tests in the three new files pass. The enabled-vs-disabled latency measurement belongs to the test-agent-live stage and is not claimed as done here.

### Re-review after fixes

**Verdict:** Concur with the review

- **Key read:** the constructor now reads the key once, at boot, through `refreshKey()`. A missing key, or a 401/403 (which clears both the key and the timestamp), is re-read at most once per `KEY_REREAD_MS` (10 min). The earlier failure mode, one blocking keychain spawn per dispatched message with a revoked key, is gone.
- **One wording point, not blocking:** a rate-limited re-read still runs synchronously inside `observeInner()`, so on the message path. The cost is at most one lookup per 10 minutes, and only while the shadow is enabled with a missing or revoked key. That bound is acceptable. §5's "never on the message path" should be read as applying to the first read only.
- **Boot-time read on dark agents:** construction now does a vault read at boot on every agent, including ones where the shadow is disabled. That is harmless. `SecretStore.read()` returns `{}` without touching the keychain when no vault file exists, it never generates a key on this path, and other boot code already reads the vault.
- **Hash bound:** sha256 is now computed over at most the first `maxScanBytes`, so hash cost is bounded.
- **Production wiring:** it is extracted into `buildJevSignalShadow()`. `server.ts` and the e2e test both build through it (live `intelligence` read, `readSecret('typesafe_api_key')`, the `logs/` path), so Tier 3 now covers the production construction path.
- **Everything else still holds:** single-flight reset, no rejection left unhandled, no leakage, disabled is inert, and the mechanical soak bound are unchanged. The three test files now hold 29 tests (up from 26), and all pass.
