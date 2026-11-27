---
title: "Owner-approved sensitive action — a device-signed approval primitive for local-forgeable handlers (SEC-018 primitive)"
slug: "owner-approved-sensitive-action"
author: "echo"
date: 2026-11-15
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
parent-principle-fit: "Several MCP handlers (threadline_trust grant, threadline_delete, threadline_pair, threadline_relay) treat `requestContext.isLocal` as owner authorization, but a local session is routinely driven by a remote peer and reads all of .instar/ + env — so a PIN or bearer proof is self-serviceable. This primitive gives those handlers ONE shared way to require a real owner approval the local session cannot forge: a Face-ID-gated owner-phone presence signature over a single-use, action-bound challenge, reusing the existing owner-presence mechanism."
binding-standards:
  - "Signal vs Authority — isLocal is a transport-locality signal; the authority is a device-signed, user-verified owner-presence approval verified server-side"
  - "Security Fixes Keep the Experience Whole (#3200) — a present owner approves in one Face-ID tap on a card naming the action in plain words; the approval RESTORES the intended (owner-decides) behavior, it is not a new degradation"
  - "No single-device lockout (operator rule 2026-09-29) — approval works from any enrolled owner phone OR the Telegram/app channel bound to the owner's verified identity, never one device"
eli16-overview: owner-approved-sensitive-action.eli16.md
approved: true
approved-by: "CoS as maintainer (non-constitution change; no Justin step), message f22e0066-7087-4db3-bcd7-2f8a321cf2bf, 2026-11-15"
review-convergence: "2026-11-16T04:46:48.619Z"
review-iterations: 2
review-completed-at: "2026-11-16T04:46:48.619Z"
review-report: "docs/specs/reports/owner-approved-sensitive-action-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 3
cheap-to-change-tags: 1
contested-then-cleared: 1
---

# Spec — Owner-approved sensitive action (SEC-018 shared primitive)

Tracking: the shared primitive that SEC-018 (trust), SEC-018b (delete), and the
`pair`/`relay` follow-ups all cite. Derived from the converged SEC-018 design
(`threadline-trust-owner-authorization.md`, 4 review rounds) after finding the
mechanism already exists.

## Problem statement

`checkAuth():473` short-circuits `isLocal` to authorized, and both MCP transports
stamp `isLocal: true`. A peer-driven local session (the A2A model spawns one from
an inbound message) therefore passes the "owner only" guard on
`threadline_trust grant` (self-grant `autonomous`), `threadline_delete`
(irreversible thread deletion), `threadline_pair`, and `threadline_relay`. The
hostile principal reads all of `.instar/` + env, so a PIN (6-digit, in
`config.json`) or the `authToken` (`$INSTAR_AUTH_TOKEN`) is self-serviceable —
no locally-verifiable low-entropy or readable secret is a valid proof. These
handlers share one need: **a real owner approval the local session cannot forge.**

## Proposed design — reuse the owner-presence mechanism as a new purpose

The owner-presence mechanism (`src/server/mobileOwnerPresenceRoutes.ts`,
`mobileConsoleTicket.ts` `verifyPresenceSignature`, spec
`mobile-owner-presence-pin.md`) already provides exactly this, Face-ID-gated, and
already backs Remote Desktop unlock + dashboard-PIN reveal. This primitive adds a
**reusable sensitive-action approval** built on it — NOT a new authenticator.

### The approval flow (per sensitive action)

1. **Challenge.** The handler, on an un-approved sensitive call, returns
   `owner-approval-required` and the server mints a **single-use, short-TTL (60 s)
   challenge** recorded as an **immutable server-side record** (B2) carrying the
   `purpose` version string, the action's identifying fields (e.g.
   `instar-trust-grant-v1` + `{fingerprint, level}`; `instar-thread-delete-v1` +
   `{threadId}`), the **resource revision the owner is reviewing** (the trust
   record's revision / the thread's state), and the **acting-machine id**. The
   owner **card is derived from that immutable record** (not from any
   caller-supplied text), so the owner reviews exactly the action the server will
   apply; if the resource state changes before the approval is consumed, the
   approval is rejected. Each purpose has its own challenge store, so a challenge
   minted for one action can never be spent on another (the existing
   per-purpose-store property). The signed presence message commits to this
   record (via the opaque challenge id, which the immutable record binds to the
   action — or by signing canonically-encoded action fields directly).
2. **Owner signs.** An **active owner phone** signs `ownerPresenceMessage(version,
   deviceId, host, challenge)` with its **Face-ID-gated presence key** (enrolled
   on the phone — an owner-physical enrollment the local session cannot perform;
   a `client:'browser'` / `dashboard-pin`-approved key is NOT a presence key and
   is not accepted). The card shown to the owner **names the action in plain
   words** (e.g. "Grant `<peer>` `<level>`?", "Delete thread `<subject>`?").
3. **Verify + consume.** `{challenge, presenceSig}` is verified by
   `verifyPresenceSignature` against the enrolled presence key and the exact
   action message, the challenge is **consumed (single-use)**, and the server
   emits a short-lived **approval token bound to {purpose, action-fields,
   trust-record-revision-or-resource-state, expiry}**.
4. **The handler requires the token.** The sensitive handler applies the action
   only with a valid, matching, unconsumed approval token — enforced at the
   **authority** (e.g. inside `AgentTrustManager.applyTrustLevel` for trust; at the
   `threadResumeMap.remove` call for delete), so no present or future caller can
   bypass it.

### Acceptance predicate (what makes the proof unforgeable here)

The server accepts the approval ONLY when: the owner-presence feature switch is
on; the request arrived over local TLS / loopback; the signer is an **active
OWNER phone** whose **presence key** is enrolled (not a browser/dashboard-pin
key); the Face-ID-gated signature validates over the exact action message; and
the challenge is unexpired + unconsumed. The presence private key lives in the
phone's secure element — never on agent disk, never offline-guessable — so the
full-local-read attacker cannot produce an accepted approval.

### No single-device lockout (condition)

Approval is accepted from **any** enrolled owner phone — more than one may be
enrolled (`devices.list().some(activeOwnerPhone)`), so condition-2 (no
single-device lockout) is **met by the owner-phone route alone**: the owner is
never tied to one device. The **owner's Telegram/app approval channel bound to
his verified identity** (`ownerDM` approve/decline, `approvalPath: 'telegram'`)
is an additional independent route. **Build-time verification (B1):** because the
local attacker reads the bot token, the Telegram route is accepted ONLY after the
build confirms the owner-DM `approve` callback is forge-resistant against a
token holder — i.e. a genuine `callback_query` whose `from.id` Telegram attests
is the owner's, bound to the exact action + single-use (a token holder may *send*
messages but cannot forge the owner's attested tap). If that confirmation does
not hold, the Telegram route is omitted and the primitive relies on the
owner-phone presence route (whose key is in the phone enclave and is
unconditionally unforgeable); condition-2 still holds via multiple enrolled
phones. An agent with no owner-approval route enrolled cannot approve a sensitive
action while the feature is on — a deliberate posture (the feature ships dark and
is enabled only where an owner route exists), not a lockout of an existing
capability.

## Decision points touched

| Decision point | Classification | Basis / justification |
|---|---|---|
| Admit a sensitive action (trust elevation, thread delete, pair, relay-toggle) | **invariant**; basis: irreversible-consequence; evidence: a forged autonomous grant / a deleted thread is not undoable | Applied only with a valid owner-presence approval token bound to the exact action; `isLocal` never admits it. Enforced at the authority. |
| The accepted signer | **invariant**; basis: enumerable-domain; evidence: the closed set {active-owner-phone presence key, telegram-dm identity route} — browser/dashboard-pin keys excluded | Deterministic predicate; the presence mechanism already enforces active-owner-phone. |
| Challenge/approval lifetime + single-use | **invariant**; basis: irreversible-consequence; evidence: a longer or reusable window widens approve→state-change→replay | 60 s challenge, consumed once; approval token bound to resource revision + short expiry, consumed atomically with the action. |

## Fixed limits

fixed-limits: none new — the 60 s challenge TTL and the approval-token expiry are inherited from the existing owner-presence challenge store (basis: irreversible-consequence; evidence: a longer or reusable window widens approve→state-change→replay exposure on an irreversible action), not limits this spec introduces.

## Multi-machine posture

`machine-local-justification: physical-credential-locality` — the presence
private key lives in the owner's phone secure element, verified on the machine
that applies the action; never on agent disk, never replicated. Enrolled presence
public keys replicate as the owner-presence mechanism already does. The challenge
+ approval token are consumed on the acting machine (bound to that machine's
resource state) and are not replicated. The approval card follows the existing
one-voice notice posture.

## Verify the State, Not Its Symbol

- **Old SYMBOL:** `isLocal === true` read as "the owner authorized this." False.
- **New SYMBOL:** a Face-ID-gated owner-phone presence signature over the exact
  action message + a consumed single-use challenge. **STATE:** the live owner, on
  a device holding a key the session can't read, user-verified (Face-ID) and
  approved THIS exact action. **Corroboration isolated from the subject:** the
  presence key is in the phone enclave; binding + single-use + expiry defeat
  reuse. **Unmeasurable case:** verifier throws / no enrolled owner route / store
  unreachable → the sensitive action is **refused** (fail closed for an
  irreversible action); a safety reduction (trust lowering/revoke) stays allowed
  (fail open) per the consumer spec.

## Crash-atomicity

Under one in-process lock, the sequence is: (1) write a **journal intent** record
{purpose, action-fields, revision, challenge-id} as `applying`; (2) verify +
consume the challenge/approval; (3) apply the resource mutation (trust write /
thread removal); (4) mark the journal `done`. On restart, recovery reads the
journal: an entry left at `applying` whose mutation did **not** land is rolled
forward only if its revision still matches (else discarded), and its challenge is
treated as consumed either way — so a crash between steps can never leave an
approval **consumed-but-replayable** nor an action **applied-without-consume**
(replay resistance survives restart). The journal records only metadata — never a
secret. (This is the concrete form of R4-2; the owner-presence challenge store's
existing durable-consume is reused where it already provides this.)

## Configuration

Reuses `mobilePairing.ownerPresence` (dev-gated, dark on the fleet) for the
presence substrate, plus `security.ownerApprovedActions: { enabled?: boolean }`
(default false) to gate the new purposes + the handler enforcement. Read live.
Rollback = `enabled: false` restores today's `isLocal` behavior for the handlers.

## Decision points / Open questions

*(none)* — the consumer specs (SEC-018 trust, SEC-018b delete) carry the
per-action gate logic (elevation definition, provenance, quarantine for trust;
the confirm-and-approve for delete) and cite this primitive for the proof.

## Maturation plan

- **test-agent-live:** a throwaway agent with an enrolled presence key, feature on: one presence-signed approval applies a sensitive action once; a replay, an expired challenge, a non-owner signer, and a browser/dashboard-pin key are each refused — all observed on the throwaway.
- **dev-agent-live:** enabled on the development agent (Echo) for one week with the delete consumer; watch that real owner Face-ID approvals land and no legitimate owner action is wrongly refused (the `owner-approval-required` → approve → apply path).
- **fleet:** flip `security.ownerApprovedActions.enabled` fleet-wide only after the dev-agent window, after the graduation criterion holds, and after the consumer gates (delete, then trust) ship — never while a sensitive action has no owner-approval route enrolled.
- **graduation criterion:** judged from the approval ledger: at least one real owner-presence approval that applied a sensitive action, AND at least one forged/non-owner/replay attempt refused, each observed. A zero count is not a pass.
- **dark-window:** at most 28 days from merge to the fleet decision; if the criterion has not held by then, it stays dark and the plan is revisited rather than flipped on a clock.
- **ladder:** not applicable: a dark-shipped security hardening primitive, not tracked on a formal feature-maturation ladder.

## Tests

- Unit: the acceptance predicate (accept an active-owner-phone presence signature
  over the exact action message + unconsumed challenge; reject a browser/dashboard-pin
  key, a wrong-action message, an expired or consumed challenge, a non-owner
  signer); challenge single-use (replay rejected); approval-token binding
  ({purpose, action-fields, revision} mismatch rejected); crash-atomicity (a crash
  between consume and apply leaves neither half-done — journal replay).
- Integration: a real AgentServer — a sensitive handler without approval returns
  `owner-approval-required`; a presence-signed approval applies the action once; a
  replay is rejected; dark default (feature off) = today's `isLocal` behavior.
- E2E: feature alive under the production init path — `owner-approval-required` /
  200, not 503.

## Awareness

New entry `src/data/awareness/owner-approved-sensitive-action.md` — tells the
agent that, when enabled, sensitive handlers (trust elevation, thread delete)
require the owner's one Face-ID approval on their phone (or the Telegram-identity
route), and that `isLocal` alone no longer authorizes them.
