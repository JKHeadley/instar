# Working-set trigger + reflex + drain + mesh-health guard (P2.2b) — the handoff fires

## What Changed

Final build slice of the Working-Set Handoff spec (P2 of multi-machine
coherence): the transfer machinery from P2.2a now FIRES — on a topic move,
on demand, and on a returning producer. Still dark everywhere except
explicitly replication-enabled pairs.

- `WorkingSetPullCoordinator`: one pipeline behind three triggers — the
  receiver's deliverMessage onAccepted seam (the moment this machine knows
  it owns the topic), the fetch reflex, and the returning-peer staggered
  drain (one pull at a time against a just-woke machine, never a mob).
  Restart-proof (topic,epoch) dedupe; nomination from journal evidence
  (every machine that actually produced artifacts, capped at 3 with the
  excess NAMED); busy responses never burn recovery budget; stale-owner
  and superseded records clear themselves.
- `POST /coherence/fetch-working-set` — the reflex: "who made artifacts
  for this topic? go get them." The EXO failure as a one-call recovery.
  503 while dark, 429 when rate-limited, coalesces into a running pull.
- `PeerVisibilityGuard` (§3.6 rider, earned from the Mini's 10 invisible
  hours): improper revocations (revokedAt with no who-or-why) surface once
  across boots; a machine missing past a 30-min grace produces ONE notice
  naming any topic workspaces stranded on it; flapping collapses to a
  single notice. All through the agent-health attention lane.
- `PeerPresencePuller.onPeerRecorded` — the re-arm rides the existing 30s
  presence cadence; no new polling loop.
- Agent Awareness + Migration Parity: the CLAUDE.md template (and
  `migrateClaudeMd` for existing agents) gains the fetch-reflex entry with
  the proactive trigger: user references files/work not on this machine →
  fire the reflex, answer from the landed files.
- State-Coherence Registry: `pull-opkeys` + `visibility-guard` categories
  (69 total).

## What to Tell Your User

On machine pairs with diary sync enabled: moving a conversation between
your machines now moves its working files too — automatically, with
nothing ever overwritten (a conflicting local copy keeps its place; the
incoming version lands alongside it). If the machine holding the files is
asleep when they're wanted, the request is written down and fires the
moment it returns — and you can always ask me to fetch a topic's workspace
on demand. Everywhere else: nothing changes yet.

## Summary of New Capabilities

- `POST /coherence/fetch-working-set {topic}` — on-demand workspace fetch
  (Bearer; 503 dark / 429 rate-limited / 200 outcome with per-nominee
  reports).
- `WorkingSetPullCoordinator` (`src/core/WorkingSetPullCoordinator.ts`) —
  move-trigger + reflex + staggered-drain orchestration.
- `PeerVisibilityGuard` / `detectImproperRevocations`
  (`src/core/PeerVisibilityGuard.ts`) — mesh-health hygiene notices.
- CLAUDE.md proactive trigger for cross-machine file references (new
  agents via template, existing agents via migrateClaudeMd).

## Evidence

- `tests/e2e/working-set-handoff-lifecycle.test.ts` — 2 passing,
  production-shaped (REAL deliverMessage handler + signed dispatcher +
  journal streams): a move lands the file (source-disk oracle; re-delivery
  + op-key dedupe leave it untouched), and THE EXO CASE end-to-end —
  producer offline at move → pending-pull survives a restart → re-fires on
  return → file lands.
- `tests/unit/WorkingSetPullCoordinator.test.ts` (12) +
  `tests/unit/PeerVisibilityGuard.test.ts` (5) +
  `tests/integration/working-set-reflex-route.test.ts` (2).
- Full P2 sweep: 95 tests / 11 suites green; typecheck, lint chain,
  docs-coverage clean.
