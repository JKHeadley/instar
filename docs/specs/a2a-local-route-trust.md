---
title: A2A local-route trust — the same-machine route asks the trust manager
slug: a2a-local-route-trust
date: 2026-10-08
author: echo
parent-spec: a2a-backup-routes.md
depends-on: a2a-inbound-id-ledger.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
parent-principle-fit: "The same-machine route cannot verify who is sending, yet it hands every sender the verified level. This change treats that identity as the guess it is: a claimed identity can only lose what the route gives today (a sender with no profile is refused, a stated level is lowered), and can never gain an operation or a stated level the route does not already give."
binding-standards: ["A Refusal Stays a Refusal — conservation of negative outcomes", "A Dark Feature Guards Nothing", "The Agent Is Always Reachable"]
eli16-overview: a2a-local-route-trust.eli16.md
approved: true
approved-by: "operator standing approval for the agent-comms track — 2026-10-06 18:57, Telegram topic 122413 (“Yes, I approve. Please don’t let me be the bottleneck here.”)"
review-convergence: "2026-10-08T20:16:03.133Z"
review-iterations: 1
review-completed-at: "2026-10-08T20:16:03.133Z"
review-report: "docs/specs/reports/a2a-local-route-trust-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# Spec — A2A local-route trust

Tracking action: ACT-056. Open items after this fix: ACT-067.

**Terms.** The *local route* is `POST /messages/relay-agent`: the route one
agent uses to hand a message straight to another agent on the same machine.
The *relay gate* is `InboundMessageGate`, which every message arriving over
the relay passes. A *trust profile* is the trust manager's record for one
peer: a level (`untrusted`, `verified`, `trusted`, `autonomous`) and the
operations that level may perform.

## Problem

The relay gate resolves the sender's fingerprint through
`AgentTrustManager.getTrustLevelByFingerprint`. A sender with no profile is
`untrusted`, and step 4 of the gate refuses any operation that level may not
perform (`insufficient_trust`); `untrusted` may only `ping` and `health`.

The local route never asks. It hands the envelope to the router with no trust
level, and the router's default is `verified`
(`relayContext?.trustLevel ?? 'verified'` in `ThreadlineRouter`). The
route's warrants-a-reply gate is also given `verified`. So a sender with no
profile may send a message over the local route, and the relay gate would
refuse the same sender.

**The relay is not uniform either (measured, see "What exists").** The relay
gate only sees a sender whose keys the relay client already knows. A
first-contact relay sender takes a separate branch that skips the gate. This
spec aligns the local route with the relay GATE and leaves that branch as it
is.

## What exists (verified on `main` = 890f02396)

- The route's bearer token is THIS agent's token from the per-machine token
  store. It proves the caller can read that file. It does not prove who the
  caller is.
- The route already resolves three identities for the inbound-id ledger:
  `registry:` (the body's `from.agent` name resolved to exactly one
  fingerprint through `known-agents.json`), `asserted:` (a well-formed
  `from.fingerprint` in the body) and `local:` (the bare name).
- A fingerprint-keyed profile is created only by an operator or agent grant
  (`threadline_trust`), by pairing, or by the relay gate AFTER a message
  passed. A name-keyed profile is created by a grant by name or by
  `TrustBootstrap`. Nothing creates a profile for an agent because it runs on
  the same machine.
- A relay message from a sender whose keys the client does not know arrives
  as an `unknown-sender` event (`ThreadlineBootstrap`). That branch skips the
  relay gate's trust and rate checks, passes the message as `verified`
  ("relay-authenticated": the relay proved the sender's key by
  challenge-response), and records it on the sender's profile, which creates
  a `verified` fingerprint profile. Measured in this spec's e2e test: gate
  counters stay at zero and one `relay-authenticated` pass is emitted.
- The trust manager exists only when the relay is enabled and this machine is
  not a relay standby (`ThreadlineBootstrap`); `server.ts` wraps it in the
  unified trust system and hands it to the routes as
  `ctx.unifiedTrust.trustManager`. If that wrap throws, the routes get none.

## Risk check: would today's working local traffic be refused?

Yes. Read on the development machine on 2026-10-08:

- one agent lists three same-machine agents in `known-agents.json` and holds
  a trust profile for one of them;
- another agent holds a single profile and has no `known-agents.json`;
- the development agent itself has no trust-profiles file at all.

None of these agents is refused today, because the local route does not ask.
Enforcing the check would refuse, on the local route, every same-machine
sender that has no profile on the receiver. What happens next depends on the
sender:

- A sender using `POST /threadline/relay-send` with a connected relay falls
  through to the relay. A first-contact sender is accepted there by the
  `unknown-sender` branch and gets a `verified` profile, so its later local
  messages pass. For these senders enforcing costs one slower first message.
- A sender whose relay is off or disconnected gets "relay not connected" and
  the message is not delivered.
- A sender using the plain cross-agent message path (`MessageRouter`, no
  relay fall-through) is not delivered.

The last two are working traffic that enforcing would cut. That is the reason
for the rollout below: the check ships in watch-only mode and counts what it
would refuse.

## Design

### 1. Resolve the sender's trust on the local route

A new module, `src/threadline/localRouteTrust.ts`, holds the decision. It
reads the trust manager and writes nothing.

Identity, in this order:

1. **Fingerprint.** The registry-resolved fingerprint. The body-asserted
   fingerprint is used ONLY when the registry resolves none. If a
   fingerprint-keyed profile exists, its level is the answer and the allowed
   operations come from `getAllowedOperationsByFingerprint`, the call the
   relay gate makes.
2. **Name.** Otherwise a profile stored under the sender name that carries
   no fingerprint (a grant by name). A profile that belongs to a fingerprint
   is reachable through step 1 only, never by its display name, so leaving
   the fingerprint out of the body never yields more than stating it. A
   name-keyed profile is checked with `checkPermission`, which honours its
   explicit block list.
3. **No profile.** `untrusted`, with the trust manager's own answer for an
   unknown sender.

The operation is classified as the relay gate classifies it: an object body
that has a `type` names the operation with it; anything else is `message`. A
`type` that is present but is not a non-empty string maps to a name no level
allows, which is the relay gate's outcome for it. The asserted fingerprint is
lower-cased for the lookup, because profiles are matched exactly.

The trust manager stays the only place the level-to-operation table lives.

### 2. What the route does with the verdict

The check runs after the bearer-token check, the envelope check and the
relay-chain loop check, and BEFORE the content window reserves and before the
inbound-id ledger admits. A refused message therefore leaves no ledger row,
holds no content window and never reaches the inbox.

| Mode | Operation allowed | Operation not allowed |
|---|---|---|
| off (`enabled` resolves false) | today's behaviour, nothing counted | today's behaviour, nothing counted |
| dry-run (default when on) | delivered as today; `allowed` counted | delivered as today; one `would-refuse` log line; `wouldRefuse` counted |
| enforcing (`dryRun: false`) | delivered; the router is given the resolved level | HTTP 403 `{ error: 'insufficient-trust', refused: true, retryable: false, operation }`; one `refuse` log line; `refused` counted |

In dry-run nothing downstream changes: the router keeps its `verified`
default. When enforcing, the resolved level replaces `verified` in the two
places a local delivery states a level: the live-inject grounding text
(`opts.localTrustLevel`) and the warrants-a-reply gate input. The stated
level is capped at `verified`: `untrusted` stays `untrusted`, and `trusted`
or `autonomous` are stated as `verified`.

**An unverified identity only ever loses.** The route cannot prove who is
sending (see "What exists"). So the check is one-directional by
construction:

- It never admits a message today's route would refuse. Today's route
  refuses nothing on trust grounds, so every verdict either leaves the
  message as it is or refuses it.
- It never states a higher level than today's `verified`. A caller that
  claims a trusted peer's name is handled exactly as today, not better.
- What a false claim can still do is avoid a refusal the caller's real
  identity would get. That is today's exposure for every sender, reduced to
  callers that name a peer this agent has granted trust to.

The 403 body carries no trust level: the level belongs to the identity the
caller claimed, and the caller is not entitled to learn it.

**No trust manager wired.** The message is handled as today and
`noTrustManager` is counted, in every mode. There is no authority to ask, and
refusing would cut off every agent that runs with the relay disabled or as a
relay standby. The count and `trustManagerWired` on `/health` make the gap
visible.

**The lookup throws.** Counted as `lookupErrors`. In dry-run the message is
delivered as today. When enforcing it is refused with HTTP 503
`{ error: 'trust-unavailable', refused: true, retryable: true }`.

**What the sender sees, and what the relay leg may do.** A sender using
`POST /threadline/relay-send` treats any non-OK local answer as a failed
local hand-over and sends the message through the relay. The local refusal is
never reported as a delivery, and it is not carried over to the relay: the
relay leg is judged again, under the relay's own rules, against the
fingerprint the relay proved. The relay may therefore ACCEPT a message the
local route refused, and that is permitted. Two cases:

- The local identity was wrong or weaker than the real one (for example a
  stale registry entry for the sender's name, while the sender's real
  fingerprint holds a profile). The relay accepting it is the better-informed
  answer.
- First contact: the relay's `unknown-sender` branch accepts the sender as
  `verified`.

So enforcing does not guarantee that an unprofiled sender's message never
arrives. It guarantees the message does not arrive on a route that cannot
prove the sender.

### Logging

One line per would-refuse or refuse verdict:
`[relay-agent-trust] would-refuse|refuse from=<name> fp=<12 hex|none> source=registry|asserted|name|none trust=<level> op=<operation>`.
The name and operation come from the request body, so they are reduced to
printable ASCII and cut to 48 characters. No message text is logged.

## What it does not do

- It does not authenticate the sender. Every identity on this route starts
  from text in the request body; the registry only maps a claimed name to a
  fingerprint. A caller holding the token can claim a granted peer's name and
  so avoid a refusal, as described above; it gains nothing beyond what the
  route gives every sender today. Proving the sender on this route needs a
  signed envelope, which is recorded on ACT-067.
- It applies the relay gate's operation-permission check only. The relay
  gate's rate limits, payload-size check and credential-ingestion branch are
  not added to the local route.
- It writes no trust history. The relay gate records a received message on
  the sender's profile, which creates a `verified` profile for a new
  fingerprint; doing that from an unauthenticated route would let a caller
  mint profiles.
- It leaves `a2a-backup-routes` unchanged: a 403 from the local route is not
  in that spec's proven non-admission set, so a fall-through after it is
  marked as a possible resend. That only changes the wording of a receiver
  notice.

## Decision points touched

| Decision point | Class | Floor + arbiter |
|---|---|---|
| Admit or refuse a local-route message by sender trust | invariant | For one fingerprint profile and one operation, when enforcing, the local route's answer equals the relay gate's step-4 answer (both call `getAllowedOperationsByFingerprint`). With `dryRun` on, the answer is only observed. |
| Which identity the lookup keys on | invariant | Registry fingerprint, then asserted fingerprint, then a fingerprint-less profile under the name; a profile that belongs to a fingerprint is never reached by name. The name step is an intended difference from the relay gate, which never reads name-keyed profiles: on this route the name is the native identity, and an operator's grant by name must work here. |
| The trust level stated to the receiving session | invariant | When enforcing: the resolved level, never above `verified`. Otherwise `verified`. |
| When to turn `dryRun` off | judgment-candidate | The operator, from the `wouldRefuse` count and log lines; never automatic. |

## Multi-machine posture

**Machine-local by design, for a concrete reason.** The local route is
loopback only: its caller is a process on the same machine holding that
machine's token file. A message for this agent that arrives on another of its
machines arrives on that machine's own local route or over the relay. There
is no cross-machine caller for this check to be consistent with.

- **Authority.** The check reads the trust manager of the machine it runs
  on, the same object that machine's relay gate reads. The invariant this
  spec adds is narrow: for one fingerprint profile and one operation, the
  local route when enforcing and the relay gate give the same answer, because
  both read that one object. The two routes can still differ on WHICH profile
  they select (the local route's identity is claimed and has a name step; the
  relay's is proven). The check adds no store of its own.
  Whatever the trust manager holds from other machines (verified-pairing
  results already replicate through `multiMachine.stateSync.threadlinePairing`)
  is used by this check automatically, and any later replication of trust
  profiles reaches it the same way.
- **Relay standby.** A standby builds no trust manager (the awake machine
  holds the agent's relay connection and its relay gate). The check there is
  a no-op that counts every message as `noTrustManager` and reports
  `trustManagerWired: false`, so a machine the check does not cover is
  visible, never silent. Refusing there would make the standby unreachable to
  its same-machine agents.
- **Counters.** In memory, per machine, not merged. The rollout decision is
  per machine because the profiles each machine would refuse on are its own;
  each machine's `/health` is read for its own decision.
- **Notices and state.** The check sends no user-facing notice, stores no
  durable state and generates no URL, so nothing can double-fire, strand on a
  topic transfer or break across a machine boundary.

## Evidence each check relies on (symbol → state)

| Symbol | Claimed state | Corroboration | Unmeasurable case |
|---|---|---|---|
| Registry fingerprint for `from.agent` | The named agent's fingerprint | `known-agents.json`, exactly one distinct match | The name itself is claimed in the body |
| A profile's level | The operator's or pairing's decision about that peer | The trust manager's stored profile | A profile created by the relay gate after a pass is `verified` by default |
| `wouldRefuse` | Attempts the trust check would refuse | One log line per count, naming sender and operation | It is counted before the content window and the ledger, so it includes attempts a later step would drop as duplicates; and a sender that never sends during the soak is not counted |

## Frontloaded Decisions

1. **The local route asks the same trust manager and applies the same
   operation check as the relay gate.**
2. **A sender with no profile is `untrusted`.** When enforcing it gets a
   pre-admission 403 with a structured body.
3. **The registry fingerprint wins over a body-asserted one.**
4. **With no trust manager wired, today's behaviour stands and is counted.**
5. **Dev-gated under `threadline.localRouteTrust`, dry-run by default.**
   Refusing needs an explicit `dryRun: false`.

## Open questions

*(none)*

## Configuration

`threadline.localRouteTrust: { enabled?: boolean; dryRun?: boolean }`, read
live per request. `enabled` omitted: the development-agent gate decides (on
for a development agent, off on the fleet). `dryRun` defaults to `true`; only
an explicit `false` refuses.

## Migration parity

- No config default is written; `enabled` is omitted on purpose. One
  `DEV_GATED_FEATURES` entry, `a2aLocalRouteTrust`.
- CLAUDE.md: a new section "A2A local-route trust" in the template and in
  `migrateClaudeMd` (sniff key `A2A local-route trust`), framework-shadowed.
- Counters on the authed `/health` under `threadline.localRouteTrust`:
  `enabled`, `dryRun`, `trustManagerWired`, `evaluated`, `allowed`,
  `wouldRefuse`, `refused`, `noTrustManager`, `lookupErrors`.

## Rollback

`threadline.localRouteTrust.enabled: false`, read live, restores today's
behaviour with no restart. `dryRun: true` stops refusing and keeps counting.
Nothing is stored, so there is no state to repair.

## Tests

- **Unit:** the decision against a real `AgentTrustManager` (no profile,
  each level against each operation compared with the relay gate's answer,
  registry over asserted, name profiles, a same-named other agent, a sender
  named after an object built-in, no writes); the mode resolver; the log line; migration parity; the router's
  grounding with and without `localTrustLevel`.
- **Integration:** the real route on a real `AgentServer` with a real trust
  manager, ledger and registry: gate off, dry-run, enforcing (403 with no
  inbox entry, no ledger row and no content window), the operation boundary,
  no trust manager, a throwing lookup, auth first.
- **E2E:** two real servers booted the production way with a real relay: the
  feature is alive on `/health`; dry-run delivers and counts; enforcing
  refuses locally, the relay leg is judged again under the relay's rules, and
  a grant restores local delivery; a stale registry entry is refused locally
  while the relay accepts the sender's proven, trusted fingerprint.

## Maturation plan

- **test-agent-live:** a throwaway agent pair on one machine with the relay
  enabled: one message from a sender with no profile in dry-run (delivered,
  one `would-refuse` line, `wouldRefuse` = 1), then the same with
  `dryRun: false` (403, `refused` = 1), then after a grant (delivered).
- **dev-agent-live:** on for 48 hours on the development agent in dry-run.
  Read the `[relay-agent-trust]` lines (each `wouldRefuse` count is an
  attempt, so the lines, which name the sender, are what is acted on); grant
  trust to each legitimate same-machine sender they name, then set
  `dryRun: false` there.
- **fleet:** the fleet decision is taken from the development agent's
  counts. The fleet step enables the check in dry-run first; enforcing on the
  fleet needs a way for same-machine agents to get profiles without a manual
  grant per pair, and a decision on the relay's `unknown-sender` branch (it
  gives a first-contact sender `verified` without the gate); both are
  recorded on ACT-067.
- **graduation criterion:** on the development agent, at least one
  evaluated local-route message, and `wouldRefuse` not rising for 24 hours
  after the grants while `dryRun` is still `true`; then at least one
  enforced delivery and zero unexplained `refuse` lines for 24 hours. A zero
  `evaluated` count is not a pass.
- **dark-window:** at most 7 days from merge to the fleet decision. If the
  criterion is not met by then, the reason and a new date are recorded on
  ACT-067; it is never left dark silently.
