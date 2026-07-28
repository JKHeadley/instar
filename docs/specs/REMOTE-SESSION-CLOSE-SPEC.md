---
title: "Remote Session Close — close any machine's session from the one dashboard"
slug: "remote-session-close"
author: "echo"
eli16-overview: "REMOTE-SESSION-CLOSE-SPEC.eli16.md"
status: "approved"
approved: true
approved-by: "Justin (uid:7812716706), Telegram topic 13481"
approved-at: "2026-06-12T07:18:23Z"
layer: "core-instar-primitive"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions (the single dashboard manages every machine's sessions; a close button that only works locally is a seam the user can feel)"
project: "multimachine-coherence"
origin: "Justin, topic 13481, 2026-06-11 16:37: 'Why can't I close out a mac mini session from the dashboard like I can the laptop sessions?' — the × button is hidden on remote tiles because closeSession only knows the local DELETE endpoint (dashboard/index.html closeSession)"
supervision: "tier0 — deterministic relay of an operator-initiated close; the relayed kill carries the SAME operator-origin semantics as a local dashboard close (NOT a guarded autonomous reap — see §2.0)"
review-convergence: "2026-06-12T05:25:22.040Z"
review-iterations: 3
review-completed-at: "2026-06-12T05:25:22.040Z"
review-report: "docs/specs/reports/remote-session-close-convergence.md"
---

# Remote Session Close — close any machine's session from the one dashboard

## 1. Problem

The dashboard's session close button (×) calls the LOCAL `DELETE /sessions/:id`, so remote tiles hide it (`dashboard/index.html`) — better no button than one that can't work. Now that click-to-stream works cross-machine, close is the visible missing half of "one dashboard manages everything"; lived 2026-06-11, cleaning five stale Mini sessions required hand-issued curl against the Mini's tunnel URL.

## 2.0 Authority — stated correctly (the round-1 correction)

**The honest truth about the existing local close, verified in code:** `DELETE /sessions/:id` stamps every Bearer-authed kill `origin: 'operator'`, and `terminateSession` runs the protected-set, lease-holder, and KEEP-guard checks ONLY for `origin === 'autonomous'`. An operator close therefore DELIBERATELY BYPASSES those guards — only the CAS-on-live-status and the in-flight lock apply. This is correct and intended: a guard exists to stop the system's OWN autonomous cleanup from killing something important; a human (or the operator's authenticated agent) clicking × is the authority the guard defers to.

**This feature inherits exactly those semantics — no more, no less.** A relayed close is the operator's close, executed on the owning machine with the identical operator-origin behavior as a local close: it WILL close a protected session (just as the local × does today). The earlier draft's claim that "guards refuse there" was FALSE and is corrected throughout. "No new authority class" remains true in the precise sense that the relay produces the same operator-origin kill the dashboard already produces locally — it does not invent a new, MORE powerful kill. What it DOES expand is reach (localhost → the pool), which is why the containment in §2.3/§3 (rate limit, URL allowlist, relay-side audit) is load-bearing, not optional.

Because protected sessions are closeable, the dashboard makes the risk legible (§2.2): the confirm dialog names the machine AND flags a protected session, so the operator is closing it knowingly — the safety is INFORMED CONSENT at the click, not a server-side refusal that does not exist.

## 2.1 The relay route — a DISTINCT path that old servers genuinely 404

`POST /sessions/:name/remote-close` with body `{ machineId, sessionUuid }` (Bearer-auth; `:name` matches the sibling sub-routes' param convention — targeting authority is the body's `sessionUuid`, the path param is display/back-compat only). A NEW path, deliberately NOT a query param on the existing `DELETE /sessions/:id`: a query param against a pre-feature/ reverted server would match the existing route and kill a LOCAL same-named session (tmux names recur across machines for ~2 reaper ticks after a transfer — a real wrong-machine kill). A new path 404s cleanly on any server that lacks it, making the §5 rollback claim true by construction and making mixed-version behavior safe.

Routing + targeting:
- **`machineId` is a registry LOOKUP KEY ONLY.** The target URL is the registry's `lastKnownUrl` for that machine — NEVER constructed from caller input. An unknown/unresolvable/offline machineId returns 404 with ZERO outbound request. `machineId` is charset-validated. (Closes the SSRF-with-credentials shape in prose, not just by current implementation.)
- **URL allowlist is a SHIPPING DEPENDENCY** (same as the converged GUARD-POSTURE-ENDPOINT-SPEC, and stronger here because this verb is destructive): the token is attached only to a `lastKnownUrl` passing the shared https + allowlisted-host helper `<!-- tracked: topic-13481-fanout-hardening -->`; a failing URL returns 502 `{error:'url-rejected', machineId}` and sends NO token. A poisoned self-advertised URL must never receive the shared pool Bearer token.
- **Target by `sessionUuid`, not tmux name.** The tile carries the UUID from the pool fan-out's full records. The peer kills the record with that id; a tmux-name fallback is backcompat-only. This dodges the ghost-record hazard (PR #1067): on a peer still carrying N 'running' records for one tmux name, a name-targeted kill picks an arbitrary record and leaves ghosts; a UUID-targeted kill closes exactly the tile the operator saw.
- **Single-hop by construction.** The relay issues the peer's PLAIN local close (no `machineId`/relay marker forwarded) — mirroring the `scope=pool` "never recursive" rule. A Tier-1 test asserts the relayed request carries no relay param, so a registry-drifted peer can never re-relay.
- **Rate-limited.** The relay path carries the `spawnLimiter` pattern (the existing DELETE route has none); one compromised dashboard browser holding the PIN-unlocked token must not iterate `machineId × session` into a pool-wide kill sweep. No bulk/loop close endpoint is added (explicit non-goal).

## 2.2 Dashboard — show × on remote tiles, with informed-consent confirm

Remote tiles render the same ×, wired to `closeSession(sessionUuid, name, machineId)` → `POST /sessions/:name/remote-close`. UX, addressing the destructive-relay realities:
- **Confirm names the machine and flags protected**: "Close session 'X' on Mac Mini?" — and for a protected session, "'X' is a PROTECTED session on Mac Mini — close it anyway?" (the informed-consent safety per §2.0). **Shipping dependency, named:** session records do NOT carry a `protected` flag today (protected status is a config-side membership test evaluated only inside `terminateSession` on the owner) — this feature ships an ADDITIVE `protected: boolean` on each `GET /sessions` record (`protectedSessions.includes(tmuxSession)`, stamped at enrichment, flowing through the pool fan-out unchanged), and the LOCAL confirm adopts the same flag (the local × gains the protected warning too — it never had one). **Version skew:** a pre-feature peer's records omit the flag, so the confirm cannot flag its protected sessions — the dashboard renders "protection status unknown (machine needs update)" for flag-less remote records rather than silently implying unprotected; stated, mirroring the §2.3 `via` skew note.
- **In-flight button state**: the clicked × shows a pending state until the relay resolves (the existing `closeSession` has none) — so a dead-peer 5s wait shows feedback, not an inert button the user double-clicks into parallel relays.
- **Re-resolve at click, not poll**: the tile may be up to 15s stale (PR #1068) or moved machines since the poll. The relay resolves placement server-side at call time; a peer 404 ("already gone / moved") renders as a CALM "already closed — refreshing" with an automatic pool refresh, NOT a scary error toast.
- **Toast normalization**: the relay normalizes the peer's reply — JSON `{ok}/{error}` passes through; a non-JSON tunnel error page (Cloudflare 502/530 HTML) becomes `{error:'<status> from <nickname>'}` so `closeSession`'s `resp.json()` can't throw into a generic "Network error" that hides the real reason.

## 2.3 Provenance, honesty, and the relay-side trail

- **Origin recording is a peer-side change, shipped on the normal release train** (NOT a relay-only header trick — the existing reap-log `origin` is the closed union `operator|autonomous`). The peer records an ADDITIVE `via: 'remote-dashboard'` field alongside the trustworthy route-stamped `origin: 'operator'` — never by widening the `origin` union (which would entangle the operator-bypass logic in `terminateSession`).
- **The `via` claim is UNTRUSTED and labeled so.** It is a caller-supplied header any token holder could forge; it is recorded as `viaClaim` (a signal, per signal-vs-authority), NEVER consulted in any authority/bypass decision. A Tier-1 test pins that a forged `via` cannot alter kill handling and is stored as unverified.
- **Version skew**: against a pre-feature peer the close still WORKS (the peer's existing DELETE needs no change to function) but logs plain `origin:'operator'` with no `via`. Accepted and stated; AC asserting the `via` trail is scoped to same-version fleets.
- **Relay-side audit (the ordering end)**: the relaying machine appends its OWN record of each relayed close (target machine, sessionUuid, outcome) to a relay-audit JSONL. The owning machine's reap-log is the authoritative record of the kill; the relay log is the record of the ORDER — "a session must never disappear without a trace naming where the order came from" must hold at BOTH ends, or a compromised laptop's kill sweep leaves no local manifest.
- **Delivery honesty, not execution claims**: on relay timeout the outcome is UNKNOWN (the peer may be mid-kill under the same load that made the session stale) — the dashboard triggers a pool refresh and reports OBSERVED state, never "closed nothing" (a fake-failure is as bad as a fake-success). Idempotent skips (in-flight / already-killed, which the existing route maps to 404) are normalized to an "already closing/closed" success UX, not a scary "not found" for a close that just won — important because simultaneous dashboard viewers are normal.
- **Peer-attested, not proof**: the relay's success response is the peer's word; the authoritative record is the owning machine's reap-log (the dashboard must not present a peer 200 as a guaranteed kill). Fully contained only once the §2.1 allowlist removes the arbitrary-attacker-peer case.

## 2.4 Agent awareness + what this is NOT

- **Agent-facing**: §2.0 includes "the operator's authenticated agent" as a caller, so `generateClaudeMd()` gains a Multi-Machine line ("close a session on any machine: `POST /sessions/:name/remote-close`") WITH the `migrateClaudeMd()` content-sniffed migration (Migration Parity). The discoverability gate does not trip (no new top-level prefix — `sessions` already exists); record that as a deliberate pass, and refresh the now-stale `INTERNAL_PREFIXES` "no agent-facing API" reason on `sessions`.
- NOT a new kill AUTHORITY: same operator-origin semantics as the local ×, executed on the owner (§2.0).
- NOT machine-to-machine autonomy: the trigger is always a human at a PIN-gated dashboard, or an agent calling the Bearer API it could already call peer-directly — the relay just collapses that to one server (which is why rate-limit + audit matter).
- NOT input forwarding: unrelated to `allowRemoteInput`; closing is not typing.
- NOT a bulk close: no loop/all-sessions endpoint (explicit non-goal, §2.1).

## 3. Testing (Testing Integrity Standard — all three tiers)

- Tier 1: route-vs-self relay decision; URL never built from `machineId` (crafted URL-shaped/traversal/unknown machineId → 404, ZERO outbound fetch); url-allowlist rejection → no token sent; single-hop (relayed request carries no relay param); forged `via` cannot alter authority + stored as unverified; toast normalization of a non-JSON peer body; rate-limiter enforcement.
- Tier 2: `GET /sessions` records carry `protected: true` for configured protected sessions (and the pool fan-out preserves it); relay to a mocked peer — success (UUID-targeted), peer-404 calm path, classified timeout (delivery-honest), HTML-error-body normalization; close-vs-transfer interleave (idempotent under the in-flight lock); ghost-bearing peer fixture (N records per tmux name → UUID targeting closes exactly one); pre-feature peer (close works, `via` absent).
- Tier 3: "feature is alive" E2E on the production init path — `POST /sessions/:name/remote-close` responds (404 for an unknown peer machineId, never 503), staged in the SAME commit as the routes change (e2e-pairing gate; EXEMPT marker forbidden).

## 4. Rollback

Revert and ship a patch: the new `POST /sessions/:name/remote-close` route disappears and old/ reverted servers 404 it cleanly (the dashboard remote × degrades to an honest "not available" toast — TRUE by construction now, unlike the query-param design). The CLAUDE.md template line needs a removal migration on rollback (Migration Parity both ways). No data migration; relay-audit + reap-log rows are append-only history.

## 5. Acceptance criteria

1. From the laptop dashboard, × on a Mac Mini session closes it BY UUID (live-verified on the real machines); the Mini's reap-log records `origin:'operator', via:'remote-dashboard'` (same-version fleet); the relaying laptop's relay-audit records the order.
2. × on a PROTECTED Mini session shows the protected-flag confirm (same-version fleet; flag-less records from pre-feature peers render "protection status unknown"); on confirm it CLOSES (operator-origin semantics, §2.0 — the honest behavior, replacing the earlier false "refuses" claim); the close is recorded at both ends.
3. × with the Mini offline / its URL non-allowlisted surfaces a named failure (`unreachable` / `url-rejected`) within 5s and sends no token; a relay TIMEOUT reports "outcome unknown — refreshing", never "closed nothing".
4. A relayed close targeting a UUID on a peer carrying multiple records for one tmux name closes exactly that record (ghost-safe); a stale tile whose session already ended renders the calm already-closed path, not an error.
5. A crafted `machineId` (URL-shaped/unknown) returns 404 with zero outbound fetch; a forged `via` header changes no authority decision.
6. The existing server route `DELETE /sessions/:id` is untouched; the dashboard's `closeSession` JS gains the uuid/machineId parameters and the protected-flag confirm (a deliberate local UX improvement, stated — not byte-for-byte JS).
