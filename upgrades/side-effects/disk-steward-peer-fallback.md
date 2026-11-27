# Side-Effects Review — Disk Read Fallback

Date: 2026-11-22. Author: Instar Agent (echo). Tier 1, SMALL: narrow reversible repair using an existing helper; no new mutation or credential authority. One Codex Sol review approved by Chief of Staff. No spec convergence rounds. Commit and gate attempts will be recorded with validation.

## Summary of the change

The API disk fan-out and scheduled peer-status reader use poolPeerFetch instead of raw single-address fetch. Production wiring carries candidate connections and their kinds, and forwards observations into the shared recorder at call time, including when mesh initialization finishes after disk initialization. Existing read response shapes remain intact. A scheduled notice acknowledgment makes one attempt over the registered address that supplied the successful status; cleanup requests remain unchanged. Linked feedback: fb-abe77867-a57.

## Decision-point inventory

Existing credential admission is passed through for the selected address and applied by the shared helper to fallback candidates. Existing GET failure/timeout/HTTP-response decisions are reused. Existing network-health authority consumes observations. No new authority, threshold, or machine-role decision is added.

## 1. Over-block

No new block/allow surface. An unapproved fallback remains refused by the existing credential rule. Ordinary peer HTTP errors return without fallback; the existing helper treats Cloudflare 520–530 as failed transport and a typed boot-beacon 503 as peer-starting.

## 2. Under-block

No credential rule is relaxed. Plain HTTP Tailscale CGNAT remains refused; fallback alone cannot restore the current M5 without a working approved endpoint. A spent timeout budget does not retry. Missing fallback candidates remain a reported peer error. The underlying reason that the operating system rejects a Node LAN connection is not changed; the working approved transport is used instead.

## 3. Level-of-abstraction fit

The existing poolPeerFetch helper owns connection retry and health reporting. Both disk consumers use it rather than adding a competing resolver or retry loop.

## 4. Signal vs authority compliance

Required reference: docs/signal-vs-authority.md. Failed and successful dials are observations fed into the existing network-health authority. Credential admission is the existing deterministic safety boundary. No brittle content detector gains blocking authority.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. This is reuse of an existing bounded read transport.

## 5. Interactions

Both readers share the resolver's actual health recorder. The callback looks up the recorder at dial time so startup ordering cannot capture a permanent null. Each attempted transport reports through the helper once. Existing holder gating and acknowledgement flow remain unchanged. POST cleanup and acknowledgement requests are not retried. The single acknowledgment targets the admitted address that served the successful, parseable GET. GET and that acknowledgment use manual redirects. URL health keys remain verbatim; only wire requests lose redundant trailing slashes.

## 6. External surfaces

Existing GET responses can now contain a measured peer reading where they previously contained a connection error. The response schema and authentication remain unchanged. Reads may contact a second registered, approved address within the same five-second budget. No data migration, credential output, or operator action is added.

## 6b. Operator UX

No operator surface or operator-facing action is added. Existing disk surfaces receive improved readings.

## 7. Multi-machine posture

Proxied-on-read: GET /disk-steward?scope=pool merges per-machine measurements. Scheduled reads use the same policy. Existing one-holder posting prevents duplicate notices. No new durable state or user URLs are introduced; existing connection health is local to the reader by design.

## 8. Rollback cost

Revert this code and ship a patch. No stored user data or backup retention changes. Disk readings may again report an unreachable peer until a healthy primary connection is selected.

## Validation

Before the repair, the new unit regression failed on missing fallback and missing production candidate wiring. Final targeted runs: 50 unit tests (5 disk fallback and 45 awareness checks), 8 HTTP integration tests, 3 production-factory/AgentServer lifecycle tests, all passed. Typecheck and diff whitespace checks passed. The lifecycle uses createDiskSteward and real AgentServer plumbing; server.ts callback wiring is checked separately by source assertion, not claimed as daemon execution. Full unit/integration/e2e suites remain the normal Local Verify release gate; throughput explicitly owns admission (e6c22951).

## Conclusion

The repair restores both read paths through the existing transport primitive and keeps cleanup side effects outside fallback.

## Independent Review

One approved Codex Sol reviewer found two issues: the notice acknowledgment must use the successful read connection, and raw resolver keys must be retained when URLs end in a slash. Both were corrected and covered by regressions. The same reviewer checked resolution of those findings and reported no remaining concern in that scope. No additional reviewer or external review was used. No convergence rounds; one commit attempt planned.
