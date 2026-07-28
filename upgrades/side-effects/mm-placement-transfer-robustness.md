# Multi-Machine Placement Observability + Reliable Transfer — Plain-English Overview

> The one-line version: an agent (and a user) can now reliably ASK which machine a topic is running on and WHY, and move a topic between machines deterministically — instead of guessing from a hostname and hoping a phrase gets recognized.

## The problem in one breath

While testing live topic-transfer on a real laptop↔mini pair, two gaps surfaced. (1) "Move this to <a machine>" worked toward a peer but silently did nothing when moving *back* to the machine currently handling the topic — the command fell through into the session as a normal message. (2) From a standby session there was no way to read where a topic actually runs or why, so the agent inferred placement and stated a guess as fact, confusing the user.

## What already exists

- **Session pool routing (§L4)** — the lease-holder polls Telegram and forwards a topic's messages to the machine that owns the session; ownership lives in the SessionOwnership registry, hard pins in the TopicPlacementPinStore (a holder-local file).
- **"move this to <nickname>" recognizer** — a deterministic recognizer over the known-machine nickname set, fed from `MachinePoolRegistry.getCapacities()`.
- **GET /pool** — shows machines, nicknames, the lease-holder. It does NOT answer per-topic placement.

## What this adds

The root cause of (1): the recognizer's known-nickname set came straight from `getCapacities()`, which can omit a machine's OWN nickname. Because the lifeline forwards inbound to the holder, the relocation check runs on the very machine you're moving back to — so its own nickname being absent made "move to self" unrecognizable. The fix unions the local machine's own nickname (resolved capacities → identity entry → deterministic derive) into the recognizer set.

On top of that, two new HTTP surfaces:

- **GET /pool/placement?topic=N** — owner machine + nickname, the REASON (`pinned` = deliberate move vs `placed` = load-balanced vs `unowned`), and the lease-holder. Answerable from any machine: a non-holder proxies to the holder, whose pin store is authoritative.
- **POST /pool/transfer {topic, to}** — a deterministic move that runs the SAME validated planner as the natural-language path (rate-limit, online, already-there checks), without depending on phrasing. A non-holder proxies to the holder.

## The new pieces

- **RelocationNicknameSet** (pure) — builds the recognizer's nickname set, unioning the self nickname. Cannot do I/O; fully unit-tested.
- **TopicPlacementDescription** (pure) — computes the placement answer from already-resolved state + a nickname resolver. No I/O.
- **Two routes** in the existing pool route group — read-only placement; mutating transfer. Both 503 when the pool is dark/single-machine.

## The safeguards

- **Reversibility / blast radius** — the recognizer change is behaviorally identical when the self nickname is already present (the common case); it only ADDS resolution when it was missing. The routes are gated: they 503 unless the pool is wired (dark by default on the fleet), so production agents are unaffected until the pool is enabled.
- **No new authority** — the transfer route reuses the existing `planTransferByNickname` planner (same rate-limit + offline-confirm gates); it does not invent a new mutation path. Ownership release uses the existing CAS.
- **Migration parity** — `PostUpdateMigrator` gains an idempotent block that appends the two new capability lines to agents that already have the pool section (guarded by a unique `/pool/placement` marker), and the freshly-injected section includes them for new agents. The CLAUDE.md template is updated in lockstep (Agent Awareness Standard).
- **Tests** — Tier 1 (12 unit: both pure helpers, incl. the exact regression), Tier 2 (11 integration: both routes over HTTP incl. pinned-vs-placed, 404/409/confirm), Tier 3 (3 e2e: routes alive through the real AgentServer + auth-gated). Full `tsc --noEmit` clean.

## Spec lineage

This is §L4 (Session Router / placement + TopicPlacement metadata) and §L5 (Transfer orchestrator) of the approved `docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md` — surfacing observability + a deterministic lever over machinery the spec already defines. No new primitives, no new authority.

## CI follow-up (same PR #750)

Two CI gates flagged the additive surface; both fixed without behavior change:
- **Docs Coverage** (`route`/`class` floors): documented the new routes + helper classes (and several related pool/mesh ones) in `site/src/content/docs/architecture/multi-machine-session-pool.md` and `features/multi-machine.md` — real feature docs the area lacked. Both floors back ≥55%.
- **no-silent-fallbacks ratchet** (457): the proxy/best-effort `catch` blocks added by the two new routes + the self-nickname resolver are annotated `@silent-fallback-ok` with honest justifications (the proxy fallbacks are explicitly labelled in the response or surface a 502; the ownership-release catch is a best-effort optimization the pin already covers). Count back to the 457 baseline — no new genuine silent fallbacks.
