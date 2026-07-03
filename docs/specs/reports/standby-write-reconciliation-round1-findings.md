# Round 1 Findings — standby-write-reconciliation

Reviewed: `docs/specs/standby-write-reconciliation.md` (commit 8afd02e0a draft).
Panel: 6 internal lenses (security, scalability, adversarial, integration,
decision-completeness, lessons-aware) + 1 external cross-model pass
(gemini-2.5-pro via gemini CLI; codex CLI not installed on this machine —
noted honestly, GPT-tier pass unavailable).

Integration lens method: every named module/route/line verified against the
real v1.3.722 tree in this worktree (grep/read, not memory).

---

## MUST-FIX

**M1 — OQ1 is load-bearing and unresolved; I2 is unsatisfiable against the real
store as written.** The real custody primitive is `SessionOwnershipRegistry`
(`src/core/SessionOwnershipRegistry.ts` — sync `read()`/`ownerOf()`/
`placementTargetOf()`, CAS at `cas()`), backed in production by
`LocalSessionOwnershipStore` (`src/core/LocalSessionOwnershipStore.ts`), whose
`read()` is an in-memory cache BUT does a synchronous `existsSync`+
`readFileSync` on cache miss (`loadOne`, :63-80), and whose `all()` performs a
full directory scan on first call (:119-136, `scanned` flag). `admitWrite`
delegating to `registry.read()` therefore violates I2 ("no fs") on first touch
of any key, and repeatedly `existsSync`s for keys with no record (negative
results are not cached). The spec must DECIDE the index strategy instead of
leaving OQ1 open. Additional grounding the decision needs: pool `sessionKey`
IS the topic id (`src/commands/server.ts:20203` — `sessionKey =
String(topicId)`), so the pool's "session ownership" is topic-keyed; and
records also arrive via `OwnershipApplier` materializing replicated journal
entries (a second mutation path besides `cas()` that any transition hook must
cover).

**M2 — Unowned-session regression: the "strictly tighter" session-scoped rule
breaks locally-spawned, never-pooled sessions on a standby.** Today's carve-out
(`guardWrite` opts.sessionScoped + `_sessionPoolActive`,
`src/core/StateManager.ts:135-139`) admits `saveSession`/`removeSession` for
EVERY session on a pool-active standby. The proposed rule ("admit iff the
ownership index confirms this machine owns <scope>") refuses any session with
NO pool ownership record — which is every locally-spawned job/headless/lifeline
session that never went through pool placement (pool records are keyed by topic
id; StateManager session files are keyed by session id — there is not even a
key-space match). Under I5 fail-closed these writes get `ownership-unresolved`
refusals where today they succeed: a REGRESSION, and one that can gate serving
an inbound message on a standby — colliding with "The Agent Is Always
Reachable" (registry §142, corollary 2). The spec must define the
unowned-session rule (e.g. no pool record for the scope ⇒ the write is
machine-local-by-construction ⇒ admit; pool record present ⇒ owner check) and
the session-id→topic mapping it relies on.

**M3 — The registry's first kv entry names a key that does not exist.** The
spec's D3/D5 first classification is prefix `build-context` →
session-scoped. The actual STATE_KEY is `session-build-context`
(`src/core/SessionBuildContextStore.ts:6`), written via `state.set` at :105
(`record()` itself is at :52, not :105 as cited). As specced, the prefix never
matches, the guarded op stays `cluster-shared`, and the headline F9 error line
(§1.1) keeps firing after the feature goes live — the fix silently doesn't fix.

**M4 — §10 leaves six open questions to the builder; decision-completeness
requires zero.** OQ2 (wave-2 inventory ownership), OQ3 (forward-on-refusal),
OQ4 (kv granularity), OQ5 (`ownership-unresolved` status code), OQ6 (gate
ordering in dryRun) must each be resolved to a frontloaded decision in the
spec body (or explicitly re-scoped out with a named follow-up), and §10
retitled/emptied. OQ1 is M1.

**M5 — Blanket fail-closed on `placing` refuses legitimate owner writes
indefinitely for the known F1-stuck topics.** The FSM already names exactly ONE
machine in every non-released state: `placing` names the placed owner and
`transferring` names the draining source (`SessionOwnershipRegistry.ownerOf`
returns `ownerMachineId` for both; `placementTargetOf`
distinguishes the target — :133-151), and the output-exclusion contract in
`SessionOwnership.ts` already governs who may act during a transfer. I5's
blanket "placing/contested → refuse" is stricter than the FSM's own
single-owner guarantee and, combined with the F1 placing-wedge class the spec
itself cites (§10 OQ1), turns five known-stuck topics into permanent
owner-write refusals until an UNRELATED upstream fix lands. Ground the
admission rule on the FSM (admit iff `ownerOf(scope) === thisMachine`, which is
well-defined in `placing`/`transferring`), or explicitly accept and justify the
stricter rule with the F1 dependency named. Either way: decide, don't defer.

## SHOULD-FIX

**S1 — Evolution store filename wrong.** §1.2 says `state/evolution/
action-queue.json`; the real file is `state/evolution/evolution-queue.json`
(`EvolutionManager.filePath` :747 + callers :782/:813).

**S2 — Event-loop gauge on `/health` must ride the AUTHED extension.**
`/health` basic body is the one unauthenticated endpoint; mesh fields
(`multiMachine.syncStatus.ropeHealth` etc.) are served authed-only. Exposing
p50/p99/max/starved-windows on the unauth body hands an outsider a live load
oracle. State the gauge lands in the authed extension (same posture as
ropeHealth).

**S3 — Parent-doc references don't resolve in the instar repo.** `parent-spec`
cites `docs/audits/mm-current-state-2026-07.md`,
`docs/audits/multi-machine-seamless-ux-audit-2026-07.md`, and
`docs/roadmaps/instar-two-goal-roadmap-2026-07.md` — none exist in this repo;
they live in the operating agent's home workspace. Qualify them (e.g.
"agent-home session-A workspace docs") so a repo reader doesn't chase dead
paths.

**S4 — Guard-manifest entry is a real deliverable, not implied.** §6 says
`writeAdmission` appears in `GET /guards`; the manifest is the STATIC
`GUARD_MANIFEST` (`src/monitoring/guardManifest.ts`) — name the manifest entry
(key, loadBearing classification, config path) as a build item so the
posture row can't be forgotten.

**S5 — Pool-dark × writeAdmission-enabled behavior unstated.** With
`multiMachine.writeAdmission` live but the session pool dark
(`_sessionPoolActive` false, empty index), what do session-/topic-scoped
domains do? Today's behavior is "blocked on standby"; state that the new model
degrades to exactly that (scoped domains refuse typed on a standby, admit on
the holder) so the combination isn't builder-improvised.

**S6 — Caller-retry brakes (P19) under-specified.** `retryable:true` invites
retry loops; the spec has no backoff contract. Add: refusals carry
`Retry-After` (seconds) on `ownership-unresolved`; internal callers that catch
`WriteRefusedError` must not busy-retry (ride their existing
schedules/backoffs); the aggregate alert is the loop's tripwire. One sentence
each closes P19.

**S7 — "Session-scoped" vs "topic-scoped" keying honesty.** Because pool
custody is keyed by topic id (M1), the two scoped domains resolve against the
SAME index with different key derivations (session-id→owning-topic vs
topic-id). Say so explicitly in D1, and name where the session-id→topic mapping
comes from (the session registry / topic bindings), or a builder will invent
one.

## LOW

**L1 — Telegram abort precision.** `apiCall` aborts at 15s for normal calls but
60s for `getUpdates` (:5361-5364). The routes in question use normal calls;
add "(60s for long-poll getUpdates)" for accuracy.

**L2 — TOCTOU residual.** Custody can move between admit and the store write
(ms window). Note it as an accepted residual: per-machine single-writer files +
journal replication converge it; same window already exists in message
routing.

**L3 — guardJournalWrite fold-in must preserve the path jail.** The journal
guard also enforces the prefix jail when NOT read-only (:162-171); "folds in
unchanged" should say the jail survives the refactor.

**L4 — Refusal hint suggests `POST /pool/transfer`.** Mark the hint
advisory-only — moving a topic is consent-gated (409 needsConfirmation for
live autonomous runs); the hint must not read as an instruction an agent
auto-follows.

**L5 — Line-ref nits.** `SessionBuildContextStore.record` is :52 (the kv write
is :105); §1.1's cite conflates them.

---

## Late round-1 integration addendum (raised while dispositioning the external pass)

**M3-b (folds into M3) — `session-build-context` is a SINGLE shared kv file on
a git-synced path; per-owner admission forks it at the FILE level.** The store
is one kv entry (`state/session-build-context.json`) holding a map keyed by
tmux session name; `.instar/state/` is NOT in FileClassifier's
excluded-from-sync patterns (`src/core/FileClassifier.ts:121-151`) and
`GitSyncManager` (debounced auto-commit+push, `src/core/GitSync.ts`) is
constructed for both roles on git-backed mesh machines
(`src/commands/server.ts:4548`). Admitting the write on every pool machine
means two machines rewrite the same file continuously → recurring git merge
conflicts routed to the LLM conflict resolver. The wave-1 fix must re-key the
store per machine (or per session) — not merely reclassify the existing key.
Generalized: every `machine-local` classification needs a named CONVERGENCE
STORY (WS2.x logical replication, per-machine pathing, or git-sync exclusion);
a shared-path store without one is refused classification.

## External pass (gemini-2.5-pro via gemini CLI) — verbatim tags + dispositions

codex CLI: **not installed** on this machine (checked PATH + homebrew + agent
bin) — GPT-tier pass honestly unavailable; Gemini-tier ran instead
(small probe first, then full pass; clean run).

1. **MUST-FIX — `placing`-stuck topics get persistent refusals** → duplicate of
   internal M5. ACCEPTED (fold).
2. **MUST-FIX — topic-scoped inventory deferred to build is too late; mandate a
   complete reviewed write-surface inventory before `dryRun:false`** →
   ACCEPTED; folds into M4 (OQ2 resolution) + a new ladder gate.
3. **SHOULD-FIX — 503+Retry-After (not 409) for `ownership-unresolved`** →
   CONTESTED, resolved differently: 409 kept uniformly BUT `Retry-After` added
   on `retryable:true`; 503 rejected because it is the house feature-dark
   signature on every route (a transient refusal must never be confusable with
   "feature dark"). Recorded as contested-then-cleared; decides OQ5.
4. **SHOULD-FIX — kv prefix matching too coarse** → ACCEPTED; decides OQ4:
   exact-key match in wave 1; a key whose granularity mixes domains is refused
   classification until the store is split/re-keyed (M3-b is the first
   instance).
5. **SHOULD-FIX — live-proof P1-A7 dependency can block acceptance
   indefinitely** → ACCEPTED; §8 acceptance refined: probes outside
   attributable starvation windows must pass; starvation-window probes are
   attributed + escalated to P1-A7 with the gauge data; a slow probe with NO
   gauge spike is a real failure of THIS feature.
6. **SHOULD-FIX — route-seam admission-throw fallback is fail-open** →
   ACCEPTED with a per-domain split: machine-local routes proceed (fail toward
   delivery — refusing would create a NEW outage for writes that are safe
   everywhere); scoped/cluster-shared routes refuse typed
   (`admission-error`, fail closed — a broken guard must not enable a fork).
   Store seam falls back to the legacy blanket verdict (exactly today).
7. **LOW — clarify dryRun cost semantics** → ACCEPTED: dryRun changes NOTHING
   in execution or spend; would-verdicts are log-only (the write-safety canary
   pattern).

## Round-1 tally

MUST-FIX: **5** (M1-M5; gemini 1-2 fold into M5/M4) · SHOULD-FIX: **9**
(S1-S7 + external 5, 6) · LOW: **6** (L1-L5 + external 7).
Verdict: NOT converged — revise and re-run.
