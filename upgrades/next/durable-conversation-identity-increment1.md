# Durable conversation identity — the registry, the crash-proof journal, and eager minting (increment 1)

<!-- bump: minor -->

## What Changed

Per `docs/specs/durable-conversation-identity.md` (review-converged round 11 —
0 CRITICAL / 0 MAJOR — approved under the standing Session-A preapproval,
topic 29836), the Phase-1 structural refactor's first increment lands: a
durable, channel-agnostic identity for conversations.

- **`ConversationRegistry` (§3):** the sparse join table between canonical key
  (`slack:<team>:<channel>[:<thread>]`), structured tuple, and a stable minted
  NEGATIVE id. Telegram positive ids pass through unregistered forever
  (back-compat by construction). The mint candidate is the legacy hash value
  (zero-loss adoption + mixed-fleet skew convergence); the registry is the
  collision authority — probe DOWN through ONE shared displacement
  implementation, bounded at `MAX_PROBE_DISTANCE = 64`.
- **The WAL journal (§3.4):** `conversation-registry.jsonl` at the stateDir
  ROOT (the one glob shape the deployed backup resolver expands — R3-C4).
  Probed/durable-binding mints fsync ONE line BEFORE the id returns; the O(N)
  snapshot is batched with a size-adaptive interval (the CommitmentTracker
  freeze shape is structurally avoided). Torn-tail discard; non-tail
  corruption fails CLOSED (quarantine-aside + attention + a durability
  incident); unknown ops (a rollback across a newer version) are
  skipped-and-preserved with snapshot-flush SUSPENSION until re-upgrade;
  single global monotonic `seq` across rotations and restarts.
- **Eager mint at Slack inbound (§6.3):** the dispatch mints (get-or-create)
  the resolved routing key's conversation id on every inbound and carries it
  as `conversationId` in message metadata + the session bootstrap context —
  the identity durable state can finally bind to. Fail-toward-delivery: a
  mint degradation never blocks a message.
- **Safety rails:** per-channel mint-rate breaker (speculative drops re-mint
  free; the durable-binding carve-out has its OWN cap + typed
  `conversation-registration-capacity` refusal); the D1 runtime kill-switch
  (`conversationIdentity.recording.enabled: false` → legacy-identical
  in-memory hashing, no redeploy; minted-id durable binds refused typed);
  §3.1 workspace pinning with per-machine `multi-workspace-unsupported`
  refusal and `_`→teamId in-place upgrade (local authenticated source only).
- **The `deliverToConversation` funnel SKELETON (§5):** typed, non-exceptional
  §5.1 results (dark/dryRun return the SAME `not-delivered` shape as
  unresolvable + a would-deliver audit line — NEVER success-shaped); local-
  origin-only resolution (KYP); system-channel suppression inside the funnel.
  ZERO consumers migrate in this increment; the E1 idempotency guard, P17
  budgets, and the deterministic gate-exempt arm land with their §6.1
  increments before any consumer rides it.
- **Read-only observability (§8):** `GET /conversations`,
  `/conversations/:id`, `/conversations/resolve`, `/conversations/health`
  (labels escaped on render; no write routes exist by design).
- **Migration parity (§6.2/§9):** backup manifest gains BOTH
  `state/conversation-registry.json` AND the `conversation-registry.jsonl*`
  glob; config defaults arrive via the add-missing merge (`recording.enabled:
  true`; `followThrough.dryRun: true` with `enabled` OMITTED — the
  developmentAgent gate resolves it); a dev-gate strip migration removes a
  default-shaped `followThrough.enabled: false`; the CLAUDE.md capability
  section reaches new agents (template) AND existing agents (migrator +
  Codex/Gemini shadow markers).

Behavior-identical for existing flows: recording is additive, delivery is
dark, the three legacy hash copies keep computing the same values the registry
records (the §4 callsite consolidation is the next increment; a grep ratchet
pins the copy set so a fourth is a CI failure).

## What to Tell Your User

<!-- audience: agent-only, maturity: experimental -->
- **Slack conversations now have a durable identity (foundation only, no
  visible change yet):** every Slack channel or thread I talk in is written
  into a permanent address book with a stable number the moment a message
  arrives, so upcoming increments can make promises/reminders/notices in
  Slack survive restarts the way they do on Telegram. A negative topic id in
  my state is one of these minted conversation ids — I can look it up in the
  address book — not an error. Delivery to Slack through this identity stays
  switched off (dry-run first on development agents).

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Conversation inventory | `GET /conversations` (Bearer; `?platform=slack`, `?limit=N`) |
| Resolve an id | `GET /conversations/:id` (positive → Telegram pass-through; unknown negative → honest 404) |
| Forward lookup (mints nothing) | `GET /conversations/resolve?key=…` or `?sessionKey=…` |
| Health + growth/suspension tripwires | `GET /conversations/health` (the Tier-3 alive target) |
| Recording kill-switch (D1) | `conversationIdentity.recording.enabled: false` (live-read, no restart) |
| Delivery gate (dark) | `conversationIdentity.followThrough` (dev-gated; `dryRun: true` first) |

## Evidence

- Spec converged round 11 (0 CRITICAL / 0 MAJOR; internal multi-lens panel +
  two external cross-model doors per round), approved under the standing
  Session-A operator preapproval (topic 29836); tag commit aa5086eb8.
- All three test tiers shipped and green: unit (79 tests across 5 files —
  golden parity with the legacy hash, frozen schema-v1 constants, the crafted
  in-charset collision pair probing to distinct ids in either order, WAL
  crash-durability without a snapshot flush, torn-tail/corruption/unknown-op
  replay rules incl. snapshot suspension, rotation-spanning replay with one
  global seq, breaker both budgets, recording kill-switch both arms,
  workspace pinning, adoption gating, funnel §5.1 typed contract, the
  mint-idiom grep ratchet), integration (7 — real authMiddleware + real
  registry through the full HTTP pipeline incl. the label-escape pin and the
  read-only resolve), migration-parity unit (7 — defaults never materialize
  `followThrough.enabled`, the #1001 strip, the backup glob expanding through
  the REAL BackupManager with every expanded file in the snapshot), e2e
  lifecycle (4 — production init path answers `/conversations/health` 200,
  the mint→restart→same-id cycle via journal replay, Telegram pass-through
  sparseness).
