---
title: A2A relay unknown-sender trust — a first contact is not a grant
slug: a2a-relay-unknown-sender-trust
date: 2026-10-09
author: echo
parent-spec: a2a-local-route-trust.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
parent-principle-fit: "The relay proves a sender holds the private key of its fingerprint. It does not prove who the sender is, and nobody granted that fingerprint anything. Today the relay path hands such a sender the `verified` level and writes it down as `verified` for good. This change makes the level the one the trust manager actually holds, and stops a first contact from creating a grant."
binding-standards: ["A Refusal Stays a Refusal — conservation of negative outcomes", "A Dark Feature Guards Nothing", "The Agent Is Always Reachable"]
eli16-overview: a2a-relay-unknown-sender-trust.eli16.md
approved: true
approved-by: "operator standing approval — 2026-10-08 14:49 (“Yes, you have my approval to proceed on this without asking for further approval”), agent-comms track"
review-convergence: "2026-10-09T13:40:00.000Z"
review-iterations: 3
review-completed-at: "2026-10-09T13:40:00.000Z"
review-report: "docs/specs/reports/a2a-relay-unknown-sender-trust-convergence.md"
cross-model-review: "codex-cli"
---

# Spec — A2A relay unknown-sender trust

Tracking action: ACT-066 (first noted on ACT-067, while building the local-route check).

**Terms.** The *relay gate* is `InboundMessageGate`: every end-to-end
encrypted message that arrives over the relay passes it. An *unknown sender*
is a relay sender whose keys this agent does not hold, so its message cannot
be decrypted; the relay client raises `unknown-sender` for it and the payload
is plaintext. A *trust profile* is the trust manager's record for one peer: a
level (`untrusted`, `verified`, `trusted`, `autonomous`) and the operations
that level may perform.

## Problem

`src/threadline/ThreadlineBootstrap.ts`, the `unknown-sender` handler:

1. skips the relay gate entirely ("relay-authenticated unknown senders bypass
   the trust manager gate");
2. emits `gate-passed` with `trustLevel: 'verified'`, reason
   `relay-authenticated`, for every message, whatever the trust manager holds;
3. calls `recordMessageReceivedByFingerprint`, which calls
   `getOrCreateProfileByFingerprint`, which creates a NEW profile at level
   `verified`, source `setup-default` (`AgentTrustManager.ts`).

So any agent on the relay can write to this agent. Its message gets an
automatic ack (`runRelayAckStage` acks every non-`untrusted` sender), an inbox
entry, the warrants-a-reply gate and a session with full tools. After the
first message the sender is `verified` on every path, including the relay
gate, permanently.

The relay's challenge-response proves the sender controls the fingerprint's
key. That is a fact about a key, not a grant of trust.

## What exists (verified on `main` = 5eea91f15)

- `InboundMessageGate.evaluate` — step 2 reads
  `getTrustLevelByFingerprint` (no profile ⇒ `untrusted`); step 3 passes
  probes (`ping`, `health`) with reason `probe`; step 4 refuses an operation
  not in `getAllowedOperationsByFingerprint` (`insufficient_trust`).
- `DEFAULT_ALLOWED_OPS`: `untrusted` = ping, health; `verified` adds
  message, query; `trusted` adds task-request, data-share; `autonomous` adds
  spawn, delegate.
- The plaintext wire (`ThreadlineClient.sendPlaintextTyped`,
  `encodePlaintextPayload`) carries `type: 'chat'` for a message and
  `type: 'ack'` for a delivery ack. Neither name is in the level table.
- The server's `gate-passed` consumer (`src/commands/server.ts`) reads
  `decision.trustLevel` for the ack stage, the inbox entry and the
  warrants-a-reply gate; `runRelayInboundWithLedger` maps reason
  `relay-authenticated` to ledger ingress `relay-unknown-sender` and skips
  the ledger for reason `probe`.
- `runRelayAckStage`: an inbound `ack` is consumed (records delivery of OUR
  earlier send) and never routed; our own ack is sent only to a sender that is
  not `untrusted`.
- Sibling fix, merged as PR #2145: the same-machine route
  (`POST /messages/relay-agent`) now resolves sender trust the same way
  (`threadline.localRouteTrust`, dev-gated, dry-run first).

## Risk check: would today's working relay traffic be refused?

On the development machine, `trust-profiles.json` holds two fingerprint
profiles, both `verified` / `setup-default` — both created by exactly the
path this spec closes. Existing profiles are NOT changed by this spec, so
those peers keep working. A peer that first writes after enforcement starts
would be refused until the operator grants it trust. That is the intended
change, and it is why the check ships watch-only.

## Design

A new pure module, `src/threadline/relayUnknownSenderTrust.ts`, holds the
decision; the bootstrap's `unknown-sender` handler calls it after the
existing payload-size check.

**Operation.** `classifyRelayPlaintextOperation(type)`: no type or `chat` ⇒
`message`; `ack` ⇒ `ack`; any other non-empty string ⇒ that name (as the gate
takes an end-to-end `type`); anything else ⇒ an operation no level allows.

**Verdict.** `resolveRelayUnknownSenderTrust(tm, fingerprint, type)`: the
level is the profile's level (no profile ⇒ `untrusted`); `allowed` is
`getAllowedOperationsByFingerprint(fp).includes(op)` — the gate's step-4
table — with two intended differences. `ack` is allowed at every level: an
ack only records that our own send arrived and is consumed before anything is
routed, and refusing it would make every peer we write to look unreachable.
And an `untrusted` sender's probe (`ping`, `health`) is NOT passed on: the
gate passes probes expecting them to be handled inline, but the server's
`gate-passed` consumer has no inline probe handler — it writes the inbox,
runs the warrants-a-reply gate and routes the text to a session. Passing a
stranger's `{type: "ping", text: "do this task"}` would hand it the session
this check exists to deny (cross-model review finding).

**Modes** (read live per message):

- **off** — today's handling, byte for byte: record the interaction, emit
  `verified`, reason `relay-authenticated`.
- **dry-run** (the default when on) — today's delivery and today's profile
  write, plus the verdict: `allowed` or `wouldRefuse` is counted and a
  would-refuse writes one `[relay-unknown-sender-trust] would-refuse` line.
  A profile this path writes at first contact during dry-run is created
  already marked (`relayFirstContact: true`, passed to
  `getOrCreateProfileByFingerprint` so the mark rides the profile's first,
  immediate write — a crash cannot leave it unmarked; round-2 cross-model
  finding). While its source is still
  `setup-default`, the verdict treats it as no profile, so every later message
  from that stranger is still counted, across restarts. Once the operator
  grants it (any other source), it counts. (Review finding: an in-memory set,
  the first design, was lost on restart and left every soak-period stranger
  holding a permanent `verified` grant after enforcement started.)
- **enforcing** (`dryRun: false`) — a refused message is dropped before
  `gate-passed`: no ack, no inbox entry, no session, no profile written,
  counted and logged. An allowed message is emitted at the HELD level
  (reason `probe` for a profiled sender's ping/health, as the gate emits;
  otherwise `relay-authenticated`, keeping the ledger ingress). Its interaction is
  recorded only when a profile already exists, so a stranger's ping writes
  nothing.

**The profile default.** `AgentTrustManager` takes an optional live reader
`newFingerprintProfileLevel`. While the check is enforcing it answers
`untrusted`, and a new fingerprint profile is created at `untrusted` with the
`untrusted` operation table. Any other answer, or a throw, keeps `verified`:
the reader can only lower the default. An operator grant
(`setTrustLevelByFingerprint`, source `user-granted`) on a new fingerprint
still lands, because an upgrade with that source is allowed.

The default is manager-wide on purpose: every creator of a fingerprint
profile is a first contact in the same sense. Besides this path that is the
relay gate's credential dry-run branch (which records an unprofiled
credential sender, today at `verified`), `recordPendingVerification` (no
production caller today) and a failed `setTrustLevelByFingerprint` (which now
leaves an `untrusted` profile, equivalent to none).

**Marked profiles on the gate path.** While enforcing, the trust manager's
`getTrustLevelByFingerprint` and `getAllowedOperationsByFingerprint` also
treat a marked, still-`setup-default` profile as `untrusted`, so the relay
gate (end-to-end path) and this path agree. Unmarked existing profiles,
including those written before this change, are never changed.

**Credentials.** `credential-share` is refused on this path at every level:
credentials never travel the plaintext fallback (verified-pairing spec),
although the operation table adds the operation for a mutual-verified
trusted peer.

**Failure.** A throwing lookup is counted (`lookupErrors`); in dry-run the
message is delivered as today, when enforcing it is dropped (fail closed —
the sender gets no answer either way, as for any gate block).

**Wire detail.** The handler no longer puts a `type: undefined` key into the
message content when the payload carries no type; every reader uses
`content.type`, which is `undefined` either way.

## What it does not do

- It does not route the unknown sender through `InboundMessageGate.evaluate`
  itself. The gate would also apply its per-level rate limits and its replay
  map; those are not part of this defect, and dry-run could not preview them
  without side effects. The trust decision is the gate's own table, read from
  the same trust manager.
- It does not change any unmarked existing profile, including those created
  at `verified` by this path before the change (both real peers on the
  development machine are such profiles). Revoking them is the operator's
  decision, made from the evidence.
- It does not fix the MCP stdio process's own trust manager, which writes the
  same `trust-profiles.json` without reloading the server's copy; a grant made
  through `threadline_trust` over MCP can be overwritten by the server's next
  save. That race predates this change and is recorded on ACT-052
  (filed 2026-10-09). A grant through the server (the dashboard or
  `setTrustLevelByFingerprint` in-process) is not affected.
- It does not change the end-to-end path, the same-machine route, or what a
  `verified` sender may do. The same consumer routes an end-to-end probe that
  the gate passes for an `untrusted` sender; that existing behaviour is
  recorded on the action filed 2026-10-09 as ACT-056 (the id was reused; the local-route fix was an earlier ACT-056) rather than changed here,
  because it is the gate's path and not the defect in this spec.
- It does not authenticate identity beyond what the relay already proves.

## Decision points touched

| Decision point | Class | Floor + arbiter |
|---|---|---|
| Pass or drop an unknown-sender relay message by sender trust | invariant | When enforcing, for one fingerprint profile and one operation, the answer equals the relay gate's step-4 answer (both call `getAllowedOperationsByFingerprint`), except: `ack` passes at every level, and an `untrusted` sender's probe is dropped. With `dryRun` on it is only observed. |
| The trust level handed to the server consumer | invariant | When enforcing: the level the trust manager holds. Otherwise `verified`, as today. |
| The level a new fingerprint profile is created at | invariant | `untrusted` while enforcing; otherwise `verified`. Can only be lowered. |
| Whether a dry-run first-contact profile is a grant | invariant | Never, while its source is `setup-default` (verdict always; gate reads while enforcing). Any decided source makes it count. |
| When to turn `dryRun` off | judgment-candidate | The operator, from `wouldRefuse` / `firstContactProfiles` and the log lines; never automatic. |

## Multi-machine posture

machine-local-justification: physical-credential-locality — the check runs where the relay connection (bound to this agent's identity key on one machine) delivers the message, against that machine's trust manager.

**Machine-local by design.** The relay admits one connection per agent
identity, held by the awake machine; only that machine receives
unknown-sender messages, and the check runs there against that machine's
trust manager — the same object its relay gate reads. A relay standby holds
no relay connection and receives nothing on this path.

- **Authority.** No store of its own. Whatever the trust manager holds from
  other machines (verified-pairing results replicate today) is used
  automatically.
- **Counters.** In memory, per machine, not merged. Each machine's
  `/health` is read for its own decision.
- **The first-contact mark.** A field on the trust profile, so it lives
  wherever that profile lives. Trust profiles are themselves per machine
  today (only verified-pairing results replicate); the mark adds no locality
  the trust it qualifies does not already have. When serving moves machines,
  the new holder judges with its own profiles: a stranger that first wrote to
  the old holder is a stranger to the new one too, which is the safe
  direction. (Conformance-gate finding, answered: the mark is
  authority-relevant, but it can only ever REMOVE a grant, so losing it on a
  move can never add one.)
- **Notices, state and URLs.** None sent, no durable state added beyond the
  profile level the trust manager already writes, no URL generated.

## Evidence each check relies on (symbol → state)

| Symbol | Claimed state | Corroboration | Unmeasurable case |
|---|---|---|---|
| The sender fingerprint | The key the sender proved to the relay | The relay's challenge-response | Who controls the key |
| A profile's level | The operator's or pairing's decision about that peer — or, for a pre-change `setup-default` profile, nobody's | The trust manager's stored profile | Which pre-change `setup-default` profiles were real peers |
| `wouldRefuse` | Unknown-sender messages enforcement would drop | One log line per count | Counts reset on restart (the first-contact marks do not) |
| `relayFirstContact` | This path wrote the profile at first contact while observing | Set only when this path creates a new profile in dry-run | Strangers seen while the check was off are not marked |

## Frontloaded Decisions

1. **The unknown-sender path reads the same trust manager and applies the
   gate's operation table.**
2. **`chat` is `message`; `ack` passes at every level.**
3. **A new fingerprint profile starts `untrusted` only while enforcing.**
4. **Existing profiles are untouched.**
5. **Dev-gated under `threadline.relayUnknownSenderTrust`, dry-run by
   default.**

## Open questions

*(none)*

## Conformance-gate findings, answered

- **Know Your Principal — pre-change `setup-default` profiles keep their
  `verified` level.** Deliberate: both real peers on the development machine
  are such profiles, and silently revoking them would cut working
  conversations. The authed `/health` reports how many remain
  (`unmarkedSetupDefaultProfiles`) so the operator can grant or revoke each
  one; that decision is ACT-069 (filed 2026-10-09; the id was reused). A mode read that
  throws is treated as "off" (today's behaviour), the same rule every
  dev-gated check here follows.
- **A Dark Feature Guards Nothing.** The check ships observing on the
  development agent with a named owner (echo) and a date: ACT-069
  (due 2026-10-11) reads the 48-hour evidence and
  sets `dryRun: false` there. The dark window on the fleet is bounded at seven
  days from merge; fleet enablement needs a trust-grant path that does not
  take one manual step per peer.

## Configuration

`threadline.relayUnknownSenderTrust: { enabled?: boolean; dryRun?: boolean }`,
read live per message (server.ts supplies the reader to the bootstrap).
`enabled` omitted: the development-agent gate decides (on for a development
agent, off on the fleet). `dryRun` defaults to `true`; only an explicit
`false` enforces. Registered in `DEV_GATED_FEATURES` as
`a2aRelayUnknownSenderTrust`. No ConfigDefaults entry.

The authed `/health` carries `threadline.relayUnknownSenderTrust`: `enabled`,
`dryRun`, `evaluated`, `allowed`, `wouldRefuse`, `refused`,
`firstContactProfiles`, `lookupErrors`, `profilesCreatedUntrusted`, and
`unmarkedSetupDefaultProfiles` (null when no trust manager is wired). The
unauthenticated `/health` does not.

## Migration parity

- CLAUDE.md template section "A2A relay unknown-sender trust" in
  `generateClaudeMd`, and the same section in `migrateClaudeMd`
  (content-sniffed on the heading), framework-shadowed for Codex/Gemini
  agents.
- No config default, hook or skill change.

## Rollback

`threadline.relayUnknownSenderTrust.enabled: false` (read live) restores
today's handling; `dryRun: true` stops dropping and keeps counting. Profiles
created at `untrusted` while enforcing stay `untrusted` — grant them with
`threadline_trust`. Code revert is a pure patch; no data migration.

## Tests

- Unit (`tests/unit/a2a-relay-unknown-sender-trust.test.ts`): operation
  classification; verdict against a real `AgentTrustManager` for every level
  × operation compared with the gate's table; the handler in off / dry-run /
  enforcing (stranger message, stranger ping, stranger ack, granted sender at
  its held level, the verified/task-request boundary, a throwing lookup,
  credential-share refused); the durable first-contact mark (survives a
  restart, ignored once granted, gate reads untrusted only while enforcing);
  the profile default (lowering only,
  throw-safe, existing profiles unchanged, grants still land); mode resolver;
  log-line sanitising; migration parity and the dev-gate entry.
- Integration (`tests/integration/threadline/a2a-relay-unknown-sender-trust.test.ts`):
  a real AgentServer's authed `/health` carries the mode and counters; the
  unauthenticated `/health` does not; a config flip is read live.
- E2E (`tests/e2e/threadline/a2a-relay-unknown-sender-trust-alive.test.ts`):
  real RelayServer, real bootstraps, a real plaintext send. Alive in dry-run
  on a development agent; a stranger delivered at `verified` and counted;
  with enforcing read live, a new stranger never reaches `gate-passed` and
  writes no profile, and the dry-run stranger's marked profile reads
  `untrusted` on the gate path; after a grant it passes at its held level.

## Maturation plan

Dry-run on the development agent for 48 hours, then echo reads
`wouldRefuse`, `firstContactProfiles`, `unmarkedSetupDefaultProfiles` and the
log lines, grants trust to the peers that are real, and sets `dryRun: false`
on the development agent (ACT-069, due 2026-10-11). Fleet
enablement waits for a way for agents to be granted trust without a manual
step per peer — the same prerequisite recorded for the sibling local-route
check on ACT-056.
