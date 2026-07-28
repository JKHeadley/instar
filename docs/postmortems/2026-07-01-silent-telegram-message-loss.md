# Postmortem — Silent Telegram Message Loss (2026-07-01)

**Status**: resolved same day; six constitutional standards ratified from it (see
below). **Fleet**: a two-machine mesh (Laptop + Mac Mini) running one agent.
**Impact**: every Telegram message from the OPERATOR silently dropped after a
mesh captain flip — no error, no loss notice, both machines' logs reading as
success — until the operator noticed the silence himself.

## Root cause chain (three stacked defects)

1. **Identity store clobbered, dormant 19 days (June 12).** A Slack live-test
   run wrote its 4 fixture users OVER the production `.instar/users.json` —
   one fixture holding **owner** permission — deleting the operator's record
   (`telegramUserId` 7812716706). Local dispatch never consults this store, so
   nothing visibly broke until mesh forwarding became the live path.
2. **Mesh sender re-validation on the corrupted store.** The owner-side
   `DeliverMessageHandler` re-validates the carried sender envelope
   (`resolveFromTelegramUserId`, strict numeric match) against the receiving
   machine's registry. The operator no longer resolved → typed NACK
   `sender-rejected` — returned BEFORE any receipt was recorded, with zero
   receiver-side logging. The machine that made the rejection decision kept no
   forensic trace of it.
3. **The refusal was encoded as success.** The sending router mapped the NACK
   to `{action:'forwarded', acked:true, detail:'sender-rejected'}`; the
   observability log line printed only action/owner/acked (detail invisible);
   the NACK is terminal by design (platform offset advances; never retried).
   Both machines' logs read as success while the operator's messages were
   permanently dropped. Stuck-recovery re-forwarded the ledger-stuck message
   3× into the same wall, then abandoned.

## Census highlights (16 defects found pulling the one thread)

Fixtures in the production user registry (with owner permission); two
authoritative identity stores contradicting for 19 days with no tripwire
(topic-operator store vs users.json); test residue in two machines'
topic-operator stores ("livetest", "g3test" bindings) found later by the new
coherence audit's first run; plaintext workspace tokens in git-tracked config;
receiver-side rejection paths with no trace; "acked" conflating wire-accepted /
durably-queued / injected; a dead Tailscale rope advertised as live for a week;
per-item alert topics flooding the operator's sidebar (~287 open attention
items, ~200 of them one repeating tick); a topic pin evaporating during the
captain flip; an LLM circuit breaker latched open forever on an idle standby;
phantom input — an auto-responder answering a driven session's questions as if
it were the driver; no end-to-end delivery proof anywhere in the monitoring
surface (every monitor measured liveness, none measured "a message actually
arrives").

## The meta-lesson: success-shaped failures

The system audits failures loudly but had no defense against a component
LYING (or being misread) as successful. An ack that means less than the caller
assumes is invisible to all failure-oriented monitoring. And every piece of
self-healing that would have prevented or shortened the incident existed in
code and shipped dark — the fleet's effective posture was the dark posture.

## Standards ratified from this incident (2026-07-01, operator-ratified)

| Standard | Registry entry |
|---|---|
| S1 | **A Refusal Stays a Refusal — conservation of negative outcomes** (Building) |
| S2 | **Cross-Store Coherence Is an Invariant** (Building) |
| S3 | **Test Identity Never Enters Production State** (Building) |
| S4 | **A Dark Feature Guards Nothing** (Shipping) |
| S5 | **Runtime End-to-End Proof — the canary standard** (Building) |
| S6 | **Session Input Is a Principal** (Substrate, extends Know Your Principal) |

## Fixes

**Same-day (originating fleet):** operator record restored on both machines via
the proper registration path; Tailscale rope restored with key-expiry watching;
a daily cross-store coherence audit (found + cleaned two more polluted stores
on its first run); a 30-minute end-to-end delivery canary (signed probe through
the real mesh RPC, per-role contract, zero-injection by construction); a
fixture-write guard at the agent tool boundary; the Slack sandbox defused (bot
token revoked, fixtures removed, re-provision runbook written); ~287 stale
per-item alert topics resolved.

**Upstream (tracked filings):** fb-1e751537-655 — refusal/receipt/ack-semantics
fix (U1); fb-b15ac10b-85c — registry-level fixture validation + the wiring-time
gate refusing to enable sender re-validation against a registry that cannot
resolve the verified operator (U2); fb-dd043916-28f — tokened driver authority
for session input (U3); fb-bcba3acc-a0d — the self-healing mesh umbrella (U4);
fb-4779424c-fc7 — duplicate replays defeating their own dedupe (census #16,
observed live three more times during the postmortem session itself).

## Timeline (PDT)

- **June 12** — fixtures clobber users.json; defect dormant (local dispatch
  doesn't read the store).
- **July 1 morning** — captain flip anchors the mesh on the Mini; mesh
  forwarding becomes the live path for laptop-pinned topics; every operator
  message begins dropping silently.
- **July 1 afternoon** — operator notices silence; diagnosis cracks it via the
  message-ledger `processing` rows + queue `terminal_reason=sender-deauthorized`;
  operator record restored; verified end-to-end at 16:23.
- **July 1 evening** — dedicated postmortem session: census, meta-analysis,
  standards ratified (topic 29836), guards G1–G4 built and deployed on the
  originating fleet, this document and the six registry entries drafted.
