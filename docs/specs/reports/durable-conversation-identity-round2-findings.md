# Round-2 convergence findings — durable-conversation-identity (to apply as Phase-2b)

Round 2 status: ALL 6 Round-1 findings VERIFIED-RESOLVED; conformance gate CLEAN (0);
decision-completeness PASSES clean (0 blocking/material, Open questions empty).
Codex external R2 = "SERIOUS ISSUES" (1 body — see /tmp/converge-r2/codex-body.txt if present).
NOT converged — the Phase-2 rewrite's own new merge-algebra (§3.5.1) introduced sibling issues.
Apply these, then run Round 3.

## MUST-FIX (affect the near-term single-machine Phase-1 path)

- **HIGH adversarial-2 — local mint probe omits merge step 2(b).** §3.3 `candidateCollides`
  filters only reserved canonicals, not already-assigned displaced ids. Two tuples colliding at
  one candidate both probe to the SAME next id → local reverse-index overwrite → cross-conversation
  mis-resolution on a SINGLE machine, before any replication. FIX: local probe must reserve against
  already-assigned displaced ids using the same ≺-ordered rule as §3.5.1 step 2(b) (maintain a live
  "taken offsets" set within the collision class) — NOT a raw occupancy check (that would re-introduce
  the Round-1 occupancy-dependent-probe HIGH). Make §3.3 local mint and §3.5.1 merge use the IDENTICAL
  displacement rule.

- **HIGH integration-1 — journal `logs/` path ambiguous between two log roots.** instar has
  `<agentHome>/.instar/logs/` (StateManager) AND `<agentHome>/logs/` (server.log/reap-log/audit).
  BackupManager resolves manifest entries as `path.join(stateDir=.instar, entry)`. If the journal is
  written to `<agentHome>/logs/` (reap-log/audit convention, which §8 calls this file), the manifest
  entry `logs/conversation-registry.jsonl` resolves to `.instar/logs/...` → DEAD manifest entry →
  disk-loss silently re-opens the CRITICAL DR hole. FIX: pin the journal EXPLICITLY at
  `<stateDir>/logs/conversation-registry.jsonl` (.instar/logs), backup entry = stateDir-relative GLOB
  `logs/conversation-registry.jsonl*` (captures rotations), and add a Tier-2 assertion that the manifest
  entry resolves to a REAL file on disk, not just a string in includeFiles.

- **HIGH lessons-1 — E1 idempotency guard window < beacon cadence + unstable key.** (a) `ambiguousDedupWindowMs`
  = 900000 (15m) is a copied Telegram constant, but PromiseBeacon re-fires at ~20m → an ambiguous re-post
  lands OUTSIDE the window → double-post still slips. (b) keying on raw content-hash breaks if the heartbeat
  interpolates elapsed/liveness text ("…23m elapsed") → retry hash differs → guard never matches. FIX: pin
  `ambiguousDedupWindowMs ≥ max beacon re-fire interval` as a STATED + TESTED invariant (not a copied constant);
  key the guard on a STABLE logical send identity (commitment id + beacon send seq), or mandate identical-buffer
  retry; make the §10 idempotency test re-fire at the REAL beacon cadence, not a sub-window fast retry.

- **MEDIUM scalability-1 — `candidateCollides` not pinned to O(1).** §3.3 prose is scan-shaped and the §10
  O(1) test covers only `byTuple`/same-tuple, not `candidateCollides` (runs on every fresh mint, up to 64
  probe steps). FIX: state `candidateCollides(id,t)` is an O(1) reverse-index lookup
  (`reverse.has(id) && reverse.get(id).tuple !== t`, or `id ∈ aliases`) — never a live-tuple scan; extend the
  §10 no-linear-scan assertion to the probe/candidateCollides path (seeded large store, bounded ops per mint).

- **MEDIUM security-NEW-3 / adversarial — ambiguous-dedup can suppress a genuinely-FAILED retry.** §5.0(a) never
  pins WHEN the window entry is recorded. If on ATTEMPT (before outcome known), a clean-transient failure
  (Slack 5xx, never posted) records the entry → next retry falsely suppressed → SILENT loss of the heartbeat.
  FIX: pin that the entry is populated ONLY on a likely-posted outcome (success OR ambiguous/ack-lost), NEVER
  on a clean transient failure where the funnel has positive evidence it did not post; add a §10 test
  (transient clean failure → retry NOT suppressed, distinct from ambiguous → single post).

## MUST-FIX before increment-9 (replication) graduates — the merge-algebra HIGHs (dark-on-fleet today)

- **HIGH adversarial-1 / security-NEW-1 — collision-demotion strands/mis-delivers a durable binding.** A late
  lower-HLC record for a colliding tuple reclaims id C as its canonical while C was the id a live commitment
  bound to; A5's alias-repoint assumes the demoted id becomes FREE, but A3's canonical-reservation reclaims C
  for the promoted tuple → the two mechanisms are mutually inconsistent exactly in the collision case A1 added.
  DESIGN CONSTRAINT: consumers hold `number`-typed topicId verbatim (168 files) — CANNOT rebind to tuples.
  So take the OTHER resolution: **a durably-bound id is NEVER demoted** — a colliding newcomer (even lower-HLC)
  is forced to probe/alias; "has a live durable binding" must be a DETERMINISTIC/replicated input to the merge
  so both machines apply it identically (commitments replicate via CommitmentsSync — make the merge consult a
  replicated durable-binding marker on the id, or journal a "sticky canonical" flag when a durable bind opens).
  Add heal-forward repoint + one deduped attention for any displaced tuple that had a local durable binding.
  Add §10 test: local durable binding on C + incoming colliding foreign tuple with lower HLC → binding still
  resolves to the victim's conversation (never stranded, never the foreign tuple).

- **MEDIUM adversarial-3 — foundation pool-relative skew quarantine → divergent accept-set R.** The bespoke store
  rides the journal transport whose `receive()` skew check is RECEIVER-relative (online vs offline-returning
  machine quarantine differently) → §3.5.1's "same R on every machine" premise not delivered by the transport;
  permanent if the bespoke ingest cursor-skips a quarantined record. FIX: for the conversations store, either
  (a) EXEMPT its ingest from the foundation's pool-relative skew quarantine (the absolute-window acceptance is
  already its machine-independent anti-forgery gate), or (b) pin that a skew-quarantined conversations record is
  RETRIED never cursor-skipped, + a §10 test (returning machine w/ stale pool reference → eventually byte-identical
  resolve()).

- **MEDIUM security-NEW-2 — replicated workspacePin (absent config) is first-writer/attacker-controlled → fleet DoS.**
  A compromised peer emits a forged workspacePin for a teamId the operator doesn't own, wins the first-writer race;
  a legit machine authenticating its REAL teamId ≠ pin refuses all concrete mints (multi-workspace-unsupported).
  FIX: a purely-replicated pin must be CORROBORATED by ≥1 LOCAL authenticated getWorkspaceId() before a machine
  fail-closes against it; a locally-authenticated concrete teamId takes precedence over a purely-replicated pin
  (same KYP posture as the rest of §3.5 — replicated is advisory, never authority). Document `workspacePin` config
  as the strongly-preferred path.

## SHOULD-FIX (medium)

- **MEDIUM lessons-2 — mass permanent-error dead-letters not emitter-aggregated (P17).** §5.1 coalesces the store
  WRITE on a mass event but emits ONE `raiseAttention` PER terminal beacon → N attention items on a
  bot-removed-from-workspace event. FIX: aggregate at the emitter into ONE summary ("N conversations became
  unreachable — bot removed from <workspace>"); add a burst-invariant test for the mass-unreachable path.

- **MEDIUM integration-2 — pre-backup synchronous saveStore() flush hook has NO mechanism + is redundant.**
  BackupManager has no before-snapshot hook; the flush is redundant with the WAL-in-backup (restore = stale
  snapshot + journal replay). FIX: DROP the pre-backup-flush requirement + its Tier-2 assertion (WAL-in-backup
  covers the un-flushed window), OR scope it as an explicit BackupManager code increment (`onBeforeSnapshot?`
  callback), not a migrator line. Prefer DROP.

- **MEDIUM lessons-3 — "always reachable on Slack" unscoped for a down adapter + §11.2 cadence.** Scope the §6.1-3
  claim ("floor holds only while the Slack transport is up; a down adapter is the SlackLifeline gap"); anchor
  §11.2 SlackLifeline to the roadmap/topic-29836 like §11.1 so the deferral re-surfaces on a cadence.

## LOW (batch)

- security-NEW-4 / scalability-2 — ambiguous-dedup map bounding not pinned; reuse the §5.2 AttentionTopicGuard
  bounded/evicting structure (hard cap + evictStaleSources) + burst-test assertion.
- security-NEW-5 — bind-time positive-Telegram-id branch under-specified; define "bound to" (topic in the
  session's authenticated bootstrap context, symmetric with the negative-id rule) + test.
- security-NEW-6 — add `workspaceId` to the §3.5 ingest type-clamp allowlist (`^T[A-Z0-9]+$`|`_`).
- adversarial-4 — `≺` tiebreak reads the MUTABLE canonical-key string; tiebreak on the IMMUTABLE tuple byte-form
  (platform, channelId, threadTs) instead (dead code today, latent landmine).
- adversarial-5 — add one honesty sentence to §3.5.1 that convergence-TOTALITY is bounded by MAX_PROBE_DISTANCE
  (a ≥64-deep genuine collision chain → pending-mint, non-convergent across unequal-R machines).
- scalability-3 — F3 statistical collision test corpus ("thousands") too small (expected collisions <1 → tautology);
  mint near the 50%-knee (~55k real-shaped ids) OR use a chi-square/bucket-occupancy uniformity metric.
- scalability-4 — batched snapshot flush still blocks the shared event loop; scope "delivery never waits" to the
  mint hot path, note async/worker write at the upper envelope.
- lessons-4/5 — reuse-lint can verify invocation not absence-of-parallel-copy (route ALL ingest normalization through
  one shared entry fn); WAL crash-consistency under-verifiable by SIGKILL tests (note residual; SQLite target sooner).
- lessons-6 — §11.8 (Slack Connect) + §11.11 (dashboard) deferrals lack a re-surfacing cadence; anchor to roadmap.
- integration/§9 — refine "flip can never lose correctness" claim: a durable BIND opened while recording:false is
  unresolvable after restart (correctness loss for that commitment) — either refuse durable binds while off, or
  narrow the claim to channel-level ids.
