# Side-effects review — PostCompact hook and record route (stores Claude's compaction summary)

**Version / slug:** `cb-post-compact`
**Date:** 2026-11-09
**Author:** Echo
**Second-pass reviewer:** independent reviewer subagent (see end)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §9.1 (PostCompact hook + settings entry + server route), §9.5, §9.7 (layer store layout), §14 (write-domain: PostCompact record route, any machine; body cap). Converged 6 rounds, approved by the operator 2026-11-09 17:22 PST (topic 141133). Phase 0, fourth slice; stacked on `cb-one-recovery-carrier`.
**Tier:** 2 (fleet-wide hook + settings migration). Size: 11 files, ~650 LOC incl. ~420 test LOC. Effort: one build pass, one second-pass round (one blocking finding, fixed), 1 commit attempt.

## Summary of the change

Claude Code's `PostCompact` hook hands `trigger` and `compact_summary` (the summary Claude wrote when it compacted). Until now nothing captured it. This slice:

1. **Hook** `.instar/hooks/instar/post-compact.sh` (template in `PostUpdateMigrator.getPostCompactHook`): on Claude Code only, with `INSTAR_AUTH_TOKEN` and `INSTAR_SESSION_ID` set and a resolvable port, reads stdin bounded (≤2 MiB, ≤1.5 s), POSTs it to `/hooks/post-compact` with `X-Instar-Session-Id`, 3 s curl cap, prints nothing, always exits 0.
2. **Settings entry** `PostCompact` → that hook, timeout 5 s: in `settings-template.json` (fresh agents), `installClaudeSettings` (init), and `migrateSettings` (existing agents; idempotent, sniffs for `post-compact.sh`). The hook file is installed by `installHooks` and always-overwritten by `migrateHooks`.
3. **Route** `POST /hooks/post-compact` (bearer-auth like every route; own 2 MB JSON parser before the broad 12 MB one): maps the Instar session → Telegram topic (or `slack-<channel>`); a session with no topic (a job) or unknown session records nothing (200, `recorded:false`). Other `hook_event_name` values → 400.
4. **Store** `src/monitoring/PostCompactStore.ts`: `scrubForStore` + an exact-value pass (§9.7) against the agent's auth token, dashboard PIN, lifeline ingress secret (pure read, never created) and every string in the secret store, each source best-effort; written atomically to `<stateDir>/state/context-layers/<topic>/post-compact/<receivedAt>-<claudeSessionId>.json` (dirs 0700, file 0600); ≤50 records per topic (oldest pruned); a summary over 512 KiB is stored as a size pointer only. Ids must match `[A-Za-z0-9_-]{1,128}`, so neither stdin nor the session table can steer the path.
5. **WriteDomainRegistry**: the route is registered machine-local, per-machine-path, git-sync-excluded. §14 calls it "any machine (arrives from the session's own machine), unified": `unified` there is the spec's scope column (same code everywhere, accepted on whichever machine hosts the session), and the registry's domain taxonomy has no `unified` value; the record itself lives only on the hosting machine, which is `machine-local` in registry terms. Same meaning, different vocabulary.
6. **File Viewer**: `state/context-layers/` and `state/context-archive/` (both prefix forms) join `NEVER_SERVED_PREFIXES` (§9.7), so the summaries are never served, linked or edited through the viewer.

Observability only in Phase 0: nothing reads these records to decide anything yet (§9.1: every later behaviour keyed on them is conditioned on `contextBudget.compactionRecovery.enabled`).

## Decision-point inventory

- No decision point that gates information flow, blocks actions or filters messages is added or modified. The route's "record or not" choice is a storage filter on its own data (topic-bound sessions only), not an authority over anything else.

## 1. Over-block

No issue identified: nothing is blocked. The hook never fails the compaction (exit 0 on every path, nothing on stdout, bounded by its 5 s timeout). Job sessions (no topic) are deliberately not recorded — the spec's topic-bound scope.

## 2. Under-block

- A session whose hook environment lacks `INSTAR_SESSION_ID` (hand-started `claude`) records nothing. Acceptable: such a session has no Instar topic either.
- If the server is down at compaction time the record is lost (no retry). Observability-only in Phase 0; the later sentinel slice's transcript detection channel counts compactions independently, so a missing record is detectable rather than silent.
- Scrubbing is shape-based plus exact values of the agent's own secrets; a third party's secret pasted in an unrecognised shape would be stored (0600, git-ignored, machine-local, never served). Same posture as the existing durable stores using `scrubForStore`.
- A summary larger than the hook's 2 MiB stdin bound is cut, arrives as invalid JSON, gets a 400 and is lost (the store would only keep a size pointer above 512 KiB anyway).
- Without `python3` the hook forwards an empty body; the route now requires `hook_event_name: "PostCompact"`, so that stores nothing instead of an empty record.
- Backup: §9.7's `state/context-layers/` backup include is not in this slice; it ships with the layer-kind slice, together with the `NEVER_BACKUP_PATH_SEGMENTS` entries for fold records, so a restore can never resurrect a fold in flight. <!-- tracked: CMT-1536 (Phase 0 task 9, layer kind) --> Until then these records are not backed up, which loses only observability data.

## 3. Level-of-abstraction fit

Right layer: the hook is the only place the summary exists; the server owns session→topic mapping and the layer store the spec names (§9.7). No parallel store: it is the first per-topic writer under `context-layers/` (slice 2's `_seeded/` markers are the only other entry), which later Phase 0/1 slices extend.

## 4. Signal vs authority compliance

Pure signal producer (stored evidence). Holds no blocking authority. Complies with `docs/signal-vs-authority.md`.

## 5. Interactions

- **SessionStart(compact) seed / CompactionSentinel seeded marker (slice 2):** independent; this route reads and writes nothing they use. Hook order between PostCompact and SessionStart(compact) does not matter.
- **PreCompactionFlush / hook-event reporter:** untouched; separate hook events.
- **Existing PostCompact entries a user added:** preserved; we append ours only if no entry already runs `post-compact.sh`.
- **Body parser:** the route-specific 2 MB parser runs first, so the broad 12 MB parser never sees a larger body for this path.

## 6. External surfaces

New hook file and settings entry on every agent (Migration Parity: template + init + migrateSettings + migrateHooks). New authenticated loopback route. New files under `.instar/state/` (git-ignored). No user-visible message, no CLAUDE.md change (no agent-facing behaviour to learn yet; the sentinel slice adds the read surface and the awareness text together). Depends on Claude Code emitting PostCompact with `compact_summary` (hook schema, verified in the spec's §9.1 table); on another engine or an older Claude Code the hook simply never runs or exits at the framework check.

## 7. Multi-machine posture

Machine-local by design: the record is written on the machine hosting the session (the hook calls its own loopback server). Registered as such in WriteDomainRegistry. A topic that moves machines leaves earlier records on the old machine; nothing reads them yet, and the spec's Phase 1 layer replication is what unifies layer state — these records are inputs to that, not a stranded authority.

## 8. Rollback cost

Low. Revert the PR; the hook file and settings entry remain on updated agents but are harmless (the route returns 404 on an older server; curl output discarded; exit 0). A later migration can remove the entry if ever needed. Stored records are inert files bounded at 50 per topic.

## Evidence

- `tests/unit/post-compact-store.test.ts` (9): 0600/0700 layout, trigger normalisation, credential-shape scrub + live-value redaction, oversize pointer, unsafe ids refused, per-topic cap prunes oldest, short values ignored; the real hook forwards stdin with the session id and prints nothing; silent no-op without token / session id / on another engine.
- `tests/integration/post-compact-route.test.ts` (4, real AgentServer): stores scrubbed summary under the Telegram topic with the live token removed; Slack keying; nothing for job / unknown session / other event; bearer required.
- `tests/e2e/post-compact-lifecycle.test.ts` (2): the update path installs the hook and settings entry; the installed hook stores the summary through the real server.
- Template/migration consumers re-run green (hook-command-project-dir-anchor, attribution-migration, CoherenceGateHook, modelTierEscalation, working-set-artifact-wiring); write-domain registry + admission tests green; `tsc --noEmit` clean.

## Second-pass review

**Reviewer (independent subagent, 2026-11-09):** "Concern raised": one blocking item — the §9.7 File Viewer never-served entries were missing, so with the viewer on a bearer/dashboard holder could open the stored summaries. Major: live-value pass narrower than §9.7 (token + PIN only); write-domain wording differs from §14. Minor: empty body from a missing python3 stored an empty record; 2 MiB truncation undisclosed; backup include absent; "first writer" claim inaccurate. Hook behaviour, id safety, auth, body-parser ordering and migration parity confirmed sound.

**Resolution:** all addressed in this commit. Never-served entries added with a test (`isNeverServed` on both prefix forms, plus a negative). Live-value pass now covers lifeline secret and secret-store values, with an integration test redacting both. Route requires the PostCompact event name (integration test: empty body → 400, nothing stored). Write-domain vocabulary reconciled in Summary item 5. Truncation, backup (tracked to the layer-kind slice) and the writer claim corrected in sections 2 and 3. Reviewer's remaining checks concurred; no design change needed beyond these.

**Reviewer re-check (same reviewer, after the fixes):** "Concur with the review." Every item confirmed resolved against the staged code. One new minor cost noted: `SecretStore.read()` runs once per compaction and can make up to two synchronous keychain calls (5 s timeout each) on the server's event loop; compactions are rare and other routes already read the store this way, so accepted. `read()` creates no key or keychain entry; the lifeline secret is only read.
