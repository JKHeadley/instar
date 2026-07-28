# Side-Effects Review — a channel registry whose defining property is that nothing can vanish from it

**Version / slug:** `channel-registry`
**Date:** `2026-07-26`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `see Phase 5`

## Summary of the change

Operator request (topic 29723): inter-agent channel choice "feels arbitrary"; there is no registry of
what channels exist and when each is appropriate. Evidence: when the relay died I stopped and reported
that I could not reach the peer. I did not evaluate alternatives — I had no way to ask what they were
or which were alive.

Adds `src/core/channelRegistry.ts` (pure resolver + state vocabulary), `src/core/instarChannels.ts`
(this agent's four peer channels with injected probes), and `GET /channels`.

**The design is NOT the list.** A hand-built list, tried first, was wrong three times in one hour —
each time by classifying something by its label rather than its consumer. The load-bearing properties:

1. **Absence is impossible.** The channel set is code-defined, never derived from what constructed
   successfully. Row count == definition count, whatever probes do.
2. **A channel that cannot determine liveness says so.** `unknown` carries a reason; it is never a
   synonym for healthy and is counted separately from `unusable`.
3. **The vocabulary matches reality:** `working | broken | half-built | reachable-no-credential |
   not-configured | unknown`. Every value was observed on a real channel; none is speculative.

## Refusal evidence (constraint 2)

```
REFUSAL 1 — drop channels whose probe failed (the incident's exact shape)
  × REGRESSION: a channel whose probe THROWS still gets a row
    → expected [ { id: 'healthy', …(7) } ] to have a length of 2 but got 1
  Tests  5 failed | 7 passed (12)

REFUSAL 2 — treat an undetermined probe as healthy (the mirror error)
  × UNKNOWN is never counted as unusable — "could not tell" is not "broken"
  × discriminates — it is not stuck on one verdict, and it reports the healthy case
  Tests  5 failed | 7 passed (12)

REFUSAL 3 — empty the ROUTE's registry
  × REGRESSION: the route serves EVERY code-defined channel — an emptied registry fails here
    → expected [] to deeply equal [ 'a2a-telegram', 'mutual-ssh', …(2) ]
  Tests  4 failed | 2 passed (6)
```

Restored: **25 passed (25)**, `tsc --noEmit` exit 0.

**Refusal 3 is the finding.** I ran it BEFORE writing the integration test: the route served zero
channels and **all 19 unit tests passed.** The module was thoroughly guarded; the wiring was not. That
is this feature's own defect one layer up — a surface reporting nothing wrong because nothing asked it
anything — and without the mandatory refusal step I would have shipped it as covered.

## Decision-point inventory

| point | classification | note |
|---|---|---|
| per-channel probe → state | `invariant` per channel | Deterministic reads of runtime state. No model call. |
| probe failure → `unknown` | `invariant` | Fails toward "undetermined", never toward healthy. |
| malformed probe result → `unknown` | `invariant` | An unrecognised shape is a failed probe, not a healthy channel. |
| 3s probe timeout | `invariant` | One wedged channel must not make the surface unanswerable. |
| `unknown` excluded from `unusable` | `invariant` | Deliberate: "could not tell" ≠ "broken". |
| a2a-telegram = `half-built` | **asserted, guarded** | Build-time fact; see §2. |

No judgment points. No LLM. Nothing gates or blocks.

## 1. Over-block

Nothing is blocked — this is a read surface with no authority over any send. The available harm is
**misinforming a reader**, and the direction that matters is a channel reported healthier than it is.
Every failure path resolves to `unknown` or a specific unusable state; no path resolves to `working`
without a probe explicitly saying so (asserted by the garbage/nullish/throw/hang tests).

The opposite over-block — reporting a working channel as unusable — would cost me a usable path
mid-outage. Guarded by the discrimination test asserting all four verdict classes occur and by the
route test asserting a connected relay reports `working`.

## 2. Under-block

**One entry is asserted, not measured.** `a2a-telegram` is reported `half-built / receive-only`
because its send function has no executing caller — a build-time property no runtime probe can see.
Mitigated by a source-scan test that fails the moment a caller appears, forcing the entry to be
corrected. Honest limit: it detects a caller in `src/`, not one added in scripts or templates.

**Liveness is construction, not round-trip.** `mutual-ssh` reports `working` when its runtime
constructed. That is NOT proof a peer was reached, and the detail string says so verbatim (asserted by
test). Real round-trip probing is a bigger change and is deliberately not bundled. <!-- tracked: CMT-1044 -->

**`peer-http` is honest but inert here.** No peer HTTP endpoint is configured, so it reports exactly
that rather than probing. On an agent that configures one, this needs a real probe.

**Not wired into the operator dashboard.** The data is available at `GET /channels`; nothing renders it.
Deliberate — the same separation I applied in #1656, and stated here rather than left for a reader to
notice. <!-- tracked: CMT-1044 -->

**It does not fix a single channel.** Two of three peer channels remain unusable. This makes their state
visible, which is a precondition for choosing between them, not a repair.

## 3. Level-of-abstraction fit

The resolver is pure (`fs`-free, network-free, clock injected) and testable without a server; the
definitions own the runtime coupling; the route owns transport. Probes are injected, which is what
made the incident state reproducible in tests.

**A smarter thing already exists and is deliberately NOT duplicated.** `/capability-registry`
(`scanState: "never-observed"`) and `/capabilities` (`autoDispatch: false` rather than an omitted key)
and a discovery adapter's breaker-aware `isAvailable()` all already implement honest-absence. This is
the same idiom applied to channels — universality, not invention. A future consolidation into
`capability-registry` as host is reasonable; it is not attempted here because that surface has its own
projection/scan lifecycle this data does not share.

## 4. Signal vs authority compliance

Pure signal, marked `advisory: true` in the response. It cannot refuse a send, select a channel, or
influence routing; nothing consumes it programmatically. `docs/signal-vs-authority.md` is satisfied
trivially. The one risk an observer carries — taking down what it watches — is closed by the probe
timeout and by the route returning a self-describing error object rather than a 500.

## 4b. Judgment-point check (Judgment Within Floors standard)

None introduced. Every branch is a deterministic read.

## 5. Interactions

- **`/threadline/status`** — reads the same `ctx.threadlineRelayClient.connectionState`; unchanged, not
  wrapped. Two surfaces over one source, deliberately: that one is threadline-specific, this one is
  cross-channel.
- **App-level auth** — `/channels` carries no per-handler auth check, matching `/capability-registry`.
  I asserted 401 first and got 200; on checking, auth is app-level middleware absent from the test
  harness by construction. Recorded in the test rather than deleted (§6b).
- **`globalThis.__instarMutualSshRuntime`** — read only. Set by `server.ts` after successful construction.
- **Excluded by design:** the upstream dispatcher and the reputation/discovery client. Both were on my
  first list; both are asserted absent by test so the category error cannot be re-introduced quietly.

## 6. External surfaces

One new authenticated read route. No config key, no persisted state, no message to any user, nothing
installed into an agent home. Response contains channel ids, purposes, verdicts and evidence strings —
no credentials, no peer identifiers, no message content.

## 6b. Operator-surface quality

Each row carries purpose / when-preferred / cost / verdict / evidence — the operator's four questions
plus the reason. Asserted non-empty for every row by test.

Wording carries two deliberate hedges earned tonight: `mutual-ssh` says construction "is not a
completed round-trip", and `not-configured` reads as a decision rather than a fault, so switched-off
infrastructure does not manufacture alarms.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, and this is a real limitation rather than a neutral choice.** Every probe
reads this process's own state; a channel healthy here may be dead on a peer machine. No replication,
no lease interaction, no generated URL. A pool-scope merge (`?scope=pool`, dark-peer tolerant) is the
obvious extension and is not attempted here. <!-- tracked: CMT-1044 -->

## 8. Rollback cost

Low. Two new modules, one route, three test files. No migration, no persisted state, no config default.
Reverting removes a read surface and nothing else; no caller depends on it.

## Phase 5 — Second-pass review

Not a gate, sentinel, guard or watchdog; holds no block/allow authority; touches no session lifecycle
or trust level. The high-risk trigger list is not engaged. Author-applied lenses, disclosed:

**Adversarial — "how would I make this useless?"** Two ways, both closed and asserted: let a failed
probe delete its channel (refusal 1), or let it report healthy (refusal 2). A third — let the route
stop asking — was open until refusal 3 found it.

**"Would it have caught the incident?"** It would have shown, in one read: relay `broken`, a2a
`half-built/receive-only`, mutual-ssh `broken`, peer-http `reachable-no-credential`. Summary: zero
working. That is the answer I needed and could not get — and notably it would ALSO have stopped me
telling the operator a fallback existed, because the row says it cannot send.

**"Symptom or cause?"** Neither: it makes the state legible. The channels are still broken.

**Weakest point:** the asserted `half-built` entry. It is guarded, but a guard scoped to `src/` is
narrower than the claim it protects, and the entry is the single place where this registry could
become the confident-but-stale label it exists to prevent.

## Post-CI addendum — three awareness registries I did not know existed

I updated `templates.ts` + `PostUpdateMigrator` by hand and believed the Agent Awareness Standard was
satisfied. CI disagreed, three times:

1. **`feature-delivery-completeness`** — the CLAUDE.md section must be listed in `featureSections`, or
   the template↔migrator parity assertion cannot see it at all.
2. **`capabilities-discoverability`** — a new route prefix must be classified in `CapabilityIndex`:
   surfaced in `/capabilities` or explicitly `INTERNAL_PREFIXES`. Its message is exactly right —
   *"The lint refuses to assume; the author makes the call."* Surfaced, since agents need it.
3. **`migrateFrameworkShadowCapabilities`** — without a marker, a Codex/Gemini agent never learns the
   capability and "will improvise a weaker workaround". That is this feature's own failure mode
   reproduced one layer out, and I would have shipped it.

**This is the Structure-over-Willpower case restated by accident.** I was deliberately doing the
awareness work and still missed three of five required registries. No amount of care would have closed
that gap; only the gates did. Recorded here rather than quietly fixed, because the ratio (2 found by
intent, 3 by machinery) is the useful number.
