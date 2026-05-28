---
approved: true
review-convergence: justin-approved-2026-05-27 (Telegram greenlight topic 13481 "I approve the spec. Please enter autonomous mode for the night." + the test-as-self-means-drive-Justins-real-Telegram correction folded into §6/§Track E; conformance pass against the six Instar standards documented in §Conformance below)
parent-specs:
  - CROSS-MACHINE-SEAMLESSNESS-SPEC.md
  - SELF-PROPAGATION-HARNESS-SPEC.md
  - SELF-PROPAGATION-HARNESS-PART-2-1-SPEC.md
---

# Spec — Multi-Machine Bootstrap Robustness + Cross-Machine Seamlessness Live Test

## TL;DR for the autonomous run

After Justin approves this spec, Echo runs autonomously and lands the following on
main in this exact order (each its own branch + PR, gate-compliant, three-tier
tests, migration parity enforced):

1. **Track A — npm publish completeness gate.** Fix the fleet-wide blocker where
   the published tarball ships an empty `dist/`. Add a publish-completeness gate.
2. **Track B — Credential redaction in join + everywhere URLs are logged.** Stop
   the join flow from logging GitHub tokens. Audit all URL-logging sites.
3. **Track C — Init→Join LaunchAgent handoff.** Stop the init's launchd plist
   from auto-respawning against the wrong agent home after a subsequent join.
4. **Track D — Mesh git substrate auto-reconcile.** Deterministic merge for lease
   + registry state when two machines auto-commit in parallel.
5. **Track F — Part 2.1 harness build.** The `instar test-as-self` orchestrator
   per the already-approved Part 2.1 spec (deferred Playwright sub-step → use
   Telegram Bot HTTP API instead, see §Track F.5 below).
6. **Track E — Cross-machine seamlessness live test.** Real two-machine bring-up
   using Tracks A–F. Lease handoff, live-tail catch-up, exactly-once redelivery.
7. **Final step — flip `multiMachine.exactlyOnceIngress` to default-on** once
   Track E passes, with a one-version dark-then-live cadence.

Stop conditions: all seven items above are merged to main, the live test passed
end-to-end with logs captured, the exactly-once flag flip shipped. Report at
real milestones to topic 13481 (workstation Echo's "instar-exo") — never the
terminal. Bob (mini :4040) untouched throughout.

---

## §1 — Problem (live evidence from the 2026-05-27 mesh bring-up)

A real bring-up of a fresh two-machine mesh tonight surfaced four distinct
operational failures, each preventing the cross-machine seamlessness test from
running. They are not bugs in the seamlessness *components* (those are
verified-on-disk + verified-on-startup-log on both machines: "Fenced lease
active / Handoff ack/yield wire active / Live-tail receiver active"). They are
bugs in the *bootstrap path* that gets us to a paired mesh.

### §1.1 — npm publish missing `dist/` (fleet-wide install blocker)

Running `npm install -g instar@1.3.47` and `npm install -g instar@1.3.48` on
both the workstation and the mini installed the package fine but produced an
empty `dist/core/`. Attempting to run `instar --version` triggered
`ERR_MODULE_NOT_FOUND` for `dist/core/TopicResumeMap.js`. Every transitively-
imported file under `dist/core/` was missing from the tarball. Fresh agent
installation of instar from npm is therefore broken across the fleet from at
least v1.3.47 (likely earlier). The workaround used tonight was rsync of the
canonical source tree's `dist/` from the workstation — that's not viable for
agents who can't reach the canonical checkout.

### §1.2 — Token leak in the `instar join` flow

During `instar join <repo-url> --code <code>` on the mini, when the server-side
pair-verification request failed, instar logged the full URL — including a live
GitHub access token — to stdout:

> `Failed to contact server: Request cannot be constructed from a URL that includes credentials: https://x-access-token:gho_MTkP7...@github.com/.../api/pair`

The token was a `gho_…` issued by Justin's local `gh` and had repo + user
scopes. It landed in the shell transcript and (almost certainly) the mini's
local logs as well. The bug is in the error-construction path — the URL
should be redacted before formatting into a log string. This same defect
likely exists in other URL-logging sites across the codebase.

### §1.3 — Init→Join LaunchAgent confusion

`instar init mmtest2 --standalone` creates a per-agent LaunchAgent plist
(`~/Library/LaunchAgents/ai.instar.<name>.plist`) pointing at the init's
agent home (`~/.instar/agents/<name>/`). On a subsequent `instar join`, the
join clones the mesh into a DIFFERENT directory (`<cwd>/instar-<name>/`).
The init's launchd plist keeps auto-respawning a server against the original
init-home, which then runs alongside (or instead of) the joined home — and
because the init-home has no joined mesh state, it never participates in the
mesh. Operator must manually `launchctl unload` the plist and remove the
init home before the joined home becomes the canonical one.

### §1.4 — Mesh git substrate divergence not auto-reconciled

The seamlessness design uses the mesh git repo as the durable substrate for
lease + registry state, with `GitSyncManager` performing periodic auto-commit
+ push. Tonight, the workstation auto-committed a lease-epoch bump while the
mini concurrently auto-committed a registry update (its own join entry).
Both pushed; one succeeded, the other got `non-fast-forward`. The losing
side's `git pull` failed with "Need to specify how to reconcile divergent
branches" and (separately) "Your local changes to the following files would
be overwritten by merge" — there is no automatic reconcile path. State
diverges silently and never converges. The workstation registry shows 1
machine, the mini registry shows 2; lease epoch on workstation runs ahead of
mini by many minutes.

### §1.5 — Operational glue, not seamlessness bugs

None of §1.1–§1.4 are bugs in PR #428's seamlessness wiring. The wiring is
verified live on both machines. They are bugs in the bootstrap UX and the
publish/sync substrates that the wiring depends on. The cross-machine
seamlessness *feature* cannot be validated end-to-end until the *bootstrap*
is robust.

---

## §2 — Goal

A fresh two-machine bootstrap requires:

- **Workstation**: `instar init mmtest2 --standalone --port 4060` (one command,
  non-interactive, idempotent).
- **Workstation**: `instar pair -d ~/.instar/agents/mmtest2` (produces code).
- **Mini**: a single one-shot command that joins the mesh (no manual
  launchctl-unload, no manual config promotion, no token leaks, no divergent
  git state, no rsync workaround).

Then `instar test-as-self --target ~/instar-canonical-test/mmtest2 --probe
"hello mesh"` runs the live cross-machine seamlessness test (lease coord,
handoff, live-tail catch-up, exactly-once redelivery) and reports a single
JSON verdict.

Once this passes, flip `multiMachine.exactlyOnceIngress` from default-off to
default-on, completing the closure of Task 5 from the original 2026-05-27
postmortem.

---

## §3 — Solution outline (seven tracks)

Each track lands as its own PR (per the instar convention "each task = its own
branch + its own PR"). All conform to the six standards in §Conformance.

### Track A — npm publish completeness gate (Tier-0 blocker)

**Problem.** The `files` field in `package.json` (or the publish workflow's
explicit file-list) is missing or incorrect, so the npm tarball ships without
`dist/`. Or `dist/` exists but the import graph is incomplete (a publish-time
exclusion that drops nested directories).

**Solution.**

1. **Audit pass.** `node scripts/audit-publish-tarball.mjs` (new) — runs
   `npm pack --dry-run --json`, walks the file list, asserts the union covers
   every relative path imported transitively from `dist/cli.js`. Fails
   loudly if any expected file is missing.

2. **Pre-publish gate.** Add the audit to `prepublishOnly` in `package.json`
   AND to `.github/workflows/publish.yml` as a hard gate.

3. **Post-publish smoke.** A scheduled workflow (`publish-smoke-test.yml`)
   does `npm pack`, extracts the tarball, runs `node dist/cli.js --version`
   in an isolated `mktemp -d` with `npm install --production` of the
   extracted package, and asserts exit 0 + correct version string.

4. **Republish v1.3.50 (or next) cleanly** with the fix.

**Files (touched):**
- `package.json` (`files` field audit + `prepublishOnly` script)
- `.github/workflows/publish.yml` (add gate)
- `.github/workflows/publish-smoke-test.yml` (new)
- `scripts/audit-publish-tarball.mjs` (new)
- `upgrades/NEXT.md` + `upgrades/side-effects/publish-completeness-gate.md`

**Tests (all three tiers).**
- Unit: `tests/unit/audit-publish-tarball.test.ts` — mock import graph,
  assert audit catches synthetic missing files.
- Integration: `tests/integration/publish-tarball.test.ts` — actually run
  `npm pack`, extract, verify cli loads.
- E2E: post-publish smoke workflow run (CI-gated, not local).

**Migration parity.** None — publish-pipeline change, no agent-installed file.

**Rollback.** Revert the PR. Old npm tarballs remain accessible.

### Track B — Credential redaction in URL logging

**Problem.** `instar join` (and likely other code paths) format URLs that may
contain `username:password@` or `x-access-token:gho_...@` into log strings
without redacting. Live tokens leak into stdout, transcripts, logs.

**Solution.**

1. **Single utility.** `src/core/redactUrl.ts` (new): `redactUrl(input:
   string|URL): string` — parses, replaces `user:pass@` segment with `***@`,
   returns the redacted string. Idempotent on already-redacted strings.

2. **Audit + apply.** `git grep -nE "https?://[^\"']+"` across `src/`,
   identify all call sites that log a URL that COULD contain credentials
   (clone URLs, fetch URLs, push URLs). Wrap each with `redactUrl(...)`
   before passing to console.\*, logger, or error message.

3. **Lint rule.** `scripts/lint-no-direct-url-log.js` (new) — fails CI if
   any new commit logs a string matching `https?://[^@]+:[^@]+@` outside the
   redactUrl module + its tests.

**Files (touched).**
- `src/core/redactUrl.ts` (new)
- `src/commands/join.ts` (or wherever join's logging lives — `git grep`
  determines exact files)
- `scripts/lint-no-direct-url-log.js` (new)
- Wired into `.husky/pre-commit` + CI
- `upgrades/NEXT.md` + `upgrades/side-effects/credential-redaction-in-url-logging.md`

**Tests.**
- Unit: `tests/unit/redactUrl.test.ts` — fuzz on basic auth, token-in-url,
  no-auth, multiple URLs in one string, malformed URLs (fail-safe to
  raw input with a warning, never throw).
- Integration: `tests/integration/join-credential-redaction.test.ts` —
  invoke join with a fake credentialed URL that intentionally fails, scrape
  stdout, assert no `gho_`/`ghp_`/`gh[su]_`/`xoxb-` pattern, and no
  literal `:secret@` substring, present.
- E2E: covered by integration since join is operator-driven.

**Migration parity.** No agent-installed file change; the redaction is in
server source. Existing agents pick up the fix on auto-update.

**Rollback.** Revert. URL logging returns to unredacted state; the lint rule
goes with it.

### Track C — Init→Join LaunchAgent handoff

**Problem.** `instar init` installs a LaunchAgent that respawns the init's
agent-home server. After `instar join`, the joined home is at a different
path. The init's plist keeps fighting the joined server for the port.

**Solution.**

There are two design options. The spec picks **Option C-2** as default; the
fallback is documented for explicit reasoning if C-2 hits an unforeseen issue.

**Option C-2 (default).** Make init's plist *agent-home-aware via a pointer
file*. Init writes the plist with a wrapper that reads
`~/.instar/agents/<name>/.instar/active-home` (new) on each launchd-driven
spawn, defaulting to the init home. Join writes the join's home path to that
pointer file. Result: the plist is stable; the agent home it spawns against
follows the pointer.

**Option C-1 (fallback).** Init's plist is marked "preliminary" via a `Label`
suffix (`ai.instar.<name>.preliminary`). Join, when it detects a preliminary
plist for the same `<name>`, removes it and installs a new
`ai.instar.<name>` plist on the joined home path.

**Why C-2 default.** The pointer-file approach is one source of truth + zero
launchd thrash; C-1 has a brief window where two plists coexist and a race
is possible if join is interrupted.

**Files (touched).**
- `src/scaffold/launchAgentInstaller.ts` (or wherever plist install lives)
  — write the wrapper + pointer-file consumer
- `src/commands/init.ts` — write the initial pointer file
- `src/commands/join.ts` — update the pointer file after a successful join
- `src/templates/launchd-wrapper.sh` (new) — the pointer-file-reading wrapper
- `upgrades/NEXT.md` + `upgrades/side-effects/init-join-launchagent-handoff.md`

**Tests.**
- Unit: `tests/unit/active-home-pointer.test.ts` — pointer file is read,
  defaults to init home, follows updates atomically.
- Integration: `tests/integration/init-then-join-launchd.test.ts` — fake
  launchd by invoking the wrapper directly; verify init→spawn-on-init-home,
  join→spawn-on-joined-home, no orphan processes after teardown.
- E2E: `tests/e2e/init-join-lifecycle.test.ts` — actually `instar init` then
  `instar join` in a `mktemp -d`, observe the resulting launchd state, kill
  cleanly. (Quarantined behind `INSTAR_E2E_LAUNCHD=1` because launchd is
  macOS-only.)

**Migration parity.** Existing agents' plists need a one-time migration: the
old plist gets replaced with the wrapper-based one via
`PostUpdateMigrator.migrateLaunchAgentToPointerFile()`. Idempotent; safe to
re-run. Custom plists (different `Label`) untouched.

**Rollback.** PostUpdateMigrator reverse migration restores the old plist
form. Pointer file harmless if left in place.

### Track D — Mesh git substrate auto-reconcile

**Problem.** Concurrent auto-commits on two machines diverge and `git pull`
fails because instar's `GitSyncManager` doesn't specify a reconcile strategy.
Once divergent, the mesh stays split-brain because:
- Mesh state files are touched by every heartbeat → constant local-only
  changes prevent `git pull` from running cleanly.
- There's no semantic merge rule (the file contents must be reconciled by
  domain logic, not by line-level git merge).

**Solution.**

1. **Semantic merge strategies.** `src/core/MergeStrategy.ts` (new) registers
   per-file merge handlers:
   - `.instar/machines/registry.json` → `mergeRegistry(local, remote)` — union
     over `machines`, take the entry with the later `lastSeen` on conflict;
     lease takes the entry with the higher `epoch`, ties broken by signature
     bytes lex order (deterministic).
   - `.instar/sync/*.json` → take-newer based on mtime in the JSON itself.
   - `.gitignore`-listed files → never committed → not reconciled.

2. **Sync algorithm rewrite.** `GitSyncManager.sync()` becomes a deterministic
   3-step:
   - `git fetch origin`
   - If `HEAD` is behind, `git pull --rebase`. On conflict, run the per-file
     semantic merger, stage, `git rebase --continue`. On any non-mesh-state
     conflict, abort + alarm (this is an operator issue, not a mesh-state
     issue).
   - `git push origin HEAD`. On `non-fast-forward`, restart from step 1
     (bounded retries; back off exponentially; surface to Attention queue
     after N failures).

3. **Heartbeat-aware staging.** The auto-commit at heartbeat time only stages
   files that have a registered semantic merger. Other locally-dirty files
   (logs, dbs, transient state) are *never* auto-committed — they're
   gitignored already, but the staging logic should be defensive: explicit
   allow-list of mesh-state files, not "stage everything".

**Files (touched).**
- `src/core/MergeStrategy.ts` (new)
- `src/core/GitSyncManager.ts` (rewrite sync algorithm)
- `src/core/mergeRegistry.ts` (new)
- `src/core/mergeLease.ts` (new)
- `upgrades/NEXT.md` + `upgrades/side-effects/mesh-git-substrate-auto-reconcile.md`

**Tests.**
- Unit: `tests/unit/mergeRegistry.test.ts` — union, lastSeen tiebreak,
  deletions handled (never delete a machine via reconcile).
- Unit: `tests/unit/mergeLease.test.ts` — higher epoch wins, signature
  tiebreak deterministic, malformed lease rejected.
- Integration: `tests/integration/git-sync-divergent-reconcile.test.ts` —
  in a tmpdir bare repo, two clones, both auto-commit and push; one wins;
  loser auto-reconciles; final state contains BOTH machines' updates.
- E2E: `tests/e2e/mesh-divergent-bring-up.test.ts` — full instar processes
  on simulated divergent state, verify reconcile within N seconds.

**Migration parity.** Server-internal logic; no agent-installed file change.
Existing agents auto-pick-up on next dist refresh.

**Rollback.** Revert. Auto-reconcile reverts to "fail, surface to operator"
behavior; this is the *previous* state, so no agent is worse off.

### Track F — Part 2.1 harness build (`instar test-as-self`)

This is the already-approved Part 2.1 of the parent self-propagation spec
(`SELF-PROPAGATION-HARNESS-PART-2-1-SPEC.md`, approved 2026-05-27 option A).
The build was unblocked tonight; this track is its execution.

**Variance from the approved Part 2.1 spec.** The approved spec called for
Playwright Telegram round-trip. Playwright MCP disconnected from this session
mid-flight and isn't reliably available. **Substitute: Telegram Bot HTTP API
direct round-trip.** That's a strictly more reliable mechanism (no browser,
no profile, no flake) and equally faithful to the round-trip test. Update
the §Step 5 in the parent spec to reflect this.

(Bot acquisition still goes through Secret Drop — that flow is unchanged.)

**Files (touched).**
- `src/commands/test-as-self.ts` (new) — the orchestrator
- `src/commands/index.ts` — register the command
- `src/scaffold/templates.ts` (`generateClaudeMd()`) — Agent Awareness
  Standard update
- `.claude/skills/test-as-self/SKILL.md` — runbook updated to "Step 1:
  run `instar test-as-self`" with manual recipe demoted to fallback
- `src/core/PostUpdateMigrator.ts` — `migrateTestAsSelfSkill()` patches
  existing on-disk SKILL.md
- `upgrades/NEXT.md` + `upgrades/side-effects/test-as-self-orchestrator.md`

**The seven gated steps** (unchanged from approved Part 2.1 spec, §The
seven steps — locked):

1. Bot acquisition (Secret Drop; refuses raw token on argv).
2. Target preparation (throwaway agent home; Bob block; canonical-home
   block).
3. Dist deploy (symlink current dist; `npm rebuild better-sqlite3`).
4. Process start (`--no-telegram` server + dedicated lifeline as sole
   poller; wait for `/health` 200 + lease file).
5. Round-trip smoke test **via Telegram Bot HTTP API** (was Playwright in
   approved Part 2.1; substitute documented above): send `sendMessage` from
   Bot A, poll `getUpdates` for Bot B's reply containing the nonce.
6. Crash + lease verification (existing `scripts/verify.mjs`).
7. Teardown (signal-safe finally).

**Tests.** Per the approved Part 2.1 spec § Test plan — unchanged.

**Migration parity.** Per the approved Part 2.1 spec § Migration parity —
unchanged.

**Rollback.** Per the approved Part 2.1 spec § Rollback — unchanged.

### Track E — Cross-machine seamlessness live test (the actual goal)

**Pre-condition.** Tracks A–F all merged to main. Two machines available:
workstation (Echo's host) + mini (Bob's host, but Bob STAYS UNTOUCHED —
the test agents are `mmtest2` on each, NOT Echo, NOT Bob).

**Procedure.**

1. **Bring-up.** On workstation, `instar test-as-self --target
   ~/.instar/agents/mmtest2 --keep`. Verify smoke passes, leave agent up
   (`--keep`).
2. **Mesh.** On workstation, `instar pair -d ~/.instar/agents/mmtest2`.
   Capture code.
3. **Bring-up on mini.** Via SSH (using the mini host alias from
   `~/.ssh/config`): `instar test-as-self --target
   ~/instar-canonical-test/mmtest2 --keep --join-mesh
   <mesh-repo-url> --code <code>`. New flags on `instar test-as-self`:
   `--join-mesh` + `--code` (extend Part 2.1's CLI surface to support the
   join mode in addition to the standalone smoke).
4. **Verify mesh formed.** Both machines' `/health` show `multiMachine.syncStatus`
   with `awakeMachineCount=1`, `holdsLease=true` on one, `false` on the
   other.
5. **Handoff test.** Trigger `POST /handoff/initiate` on the holder, pointing
   at the standby. Assert: holder yields ONLY after ack; standby acquires
   ONLY on yield; no two-captains; total transition < 5s.
6. **Live-tail catch-up test.** Drive a synthetic conversation turn (no
   user; the orchestrator posts a simulated inbound message into the
   holder's adapter), wait for live-tail to fire, force a handoff, verify
   standby's `/topic-intent/<topic>/refs` contains the new turn within N
   seconds of the handoff.
7. **Exactly-once redelivery test.** Flip
   `multiMachine.exactlyOnceIngress=true` on both ends (via config push +
   `/internal/config-reload`). Post the same Telegram message id twice (the
   second is a simulated provider-redelivery). Verify exactly ONE reply
   committed; verify the dedup ledger records both inbound message-ids,
   only one as "answered". Failover the holder mid-flight, verify the new
   holder receives the `reply_committed` marker via
   `ReplyMarkerTransport`, refuses to re-send.

7b. **THE PROVING TEST — drive Justin's real Telegram (test-as-self, true sense).**
   Per Justin's 2026-05-27 correction, the *final* validation is NOT a
   synthetic bot round-trip — it is Echo DIRECTLY USING JUSTIN'S real
   Telegram (the logged-in browser profile) to drive the scenario from the
   user's chair. Concretely: the mmtest2 mesh is bound to a real Telegram
   bot Echo minted itself via @BotFather (through the same logged-in
   profile — NOT via Secret Drop, NOT via a Justin ask). Echo then, AS
   JUSTIN in his logged-in Telegram, sends a real message to that bot,
   observes the agent reply, forces a cross-machine handoff mid-exchange,
   and confirms from the user-facing Telegram view that: the reply still
   arrives, it arrives exactly once, and the conversation continues
   seamlessly across the machine boundary. The observed Telegram
   experience — not the logs — is the verdict. Logs corroborate; the
   real Telegram view decides.
8. **Teardown.** `instar test-as-self --target ... --teardown` on both
   ends (extends Part 2.1's CLI: new `--teardown` flag for explicit
   already-running cleanup).
9. **Report verdict.** Single JSON report at
   `~/.instar/agents/echo/test-reports/cross-machine-seamlessness-<ts>.json`
   + a Telegram post to topic 13481 (silent on success, plain English on
   failure with the step that failed + the evidence).

**Files (touched).**
- `tests/e2e/cross-machine-seamlessness-live.test.ts` (new, quarantined
  behind `INSTAR_E2E_CROSS_MACHINE=1` because it requires a real second
  machine)
- `src/commands/test-as-self.ts` (extend CLI with `--join-mesh`, `--code`,
  `--teardown` flags)
- Update CLAUDE.md template to mention the live test recipe
- `upgrades/NEXT.md` + `upgrades/side-effects/cross-machine-live-test.md`

**Tests.** The E2E test IS the test; the orchestrator's added flag logic
gets unit + integration coverage:
- Unit: argument validation rejects nonsense combinations
  (`--join-mesh` without `--code`, `--teardown` without prior `--keep`).
- Integration: `--join-mesh` flow against a tmpdir bare repo.

**Migration parity.** None — adding flags is additive.

**Rollback.** Don't run the test. Code is harmless.

### Final step — flip `multiMachine.exactlyOnceIngress` to default-on

**Pre-condition.** Track E's exactly-once redelivery test passed twice in a
row, no false-drops, no double-replies, both directions of handoff.

**Procedure.** A single PR that:

1. Changes the config default in `src/core/types.ts` from
   `exactlyOnceIngress: false` to `true`.
2. Adds `migrateExactlyOnceDefault()` in `PostUpdateMigrator` — for
   existing agents whose config has the flag *explicitly* set, do NOT touch
   it (respect operator's explicit choice). Only flip the default for
   agents where the flag is absent.
3. NEXT.md entry: "Cross-machine exactly-once ingress now default-on" with
   the explicit-override note.

**Tests.**
- Unit: migrator behaviour with absent / explicit-false / explicit-true
  configs.
- E2E: lifecycle test that the default fires through to the server's
  feature-gating logic.

**Migration parity.** Migrator handles it.

**Rollback.** Flip the default back; migrator continues to respect
explicit-set.

---

## §4 — Conformance pass against the six Instar standards

| Standard | Track A | Track B | Track C | Track D | Track E | Track F | Final |
|---|---|---|---|---|---|---|---|
| **No-manual-work** | ✅ gate runs at publish | ✅ lint enforces at commit | ✅ pointer-file is structural | ✅ semantic merger is structural | ✅ live test orchestrated | ✅ one-button cmd | ✅ migrator is auto |
| **Structure > Willpower** | ✅ enforced in workflow | ✅ enforced in lint | ✅ enforced in plist wrapper | ✅ enforced in MergeStrategy | ✅ enforced in test orchestrator | ✅ enforced in CLI | ✅ enforced in migrator |
| **Signal vs Authority** | Gate IS authority (publish blocker — correct, this is a release gate) | Lint IS authority (no live token can ever ship) | Pointer file is signal | Reconcile signals via merge result | Test is signal | Test orchestrator is signal | Migrator is authority (config change) |
| **Near-silent** | ✅ silent on success | ✅ silent on success | ✅ silent on success | ✅ silent on success | ✅ silent on success (Telegram only on failure) | ✅ silent on success | ✅ NEXT.md entry only |
| **3-tier testing** | ✅ unit + integration + post-publish | ✅ unit + integration | ✅ unit + integration + E2E (quarantined) | ✅ unit + integration + E2E | ✅ E2E IS the test | ✅ per parent Part 2.1 spec | ✅ unit + E2E |
| **Migration parity** | N/A (publish-only) | N/A (server-only) | ✅ migrator | N/A (server-only) | N/A (test-only) | ✅ per parent Part 2.1 spec | ✅ migrator |

All seven items conform across all six standards.

---

## §5 — Order, parallelism, and dependency

```
Track A ──┐
Track B ──┤
Track C ──┼──► Track F ──► Track E ──► Final
Track D ──┘
```

Tracks A–D are independent and can land in parallel (Echo opens four PRs
roughly simultaneously, watches CI, merges as they go green). Track F
requires A landed (so a fresh agent install works) and the others ideally
landed (so the live test has a clean substrate). Track E requires F + the
others. Final requires E green.

Estimated wall time, single autonomous session:
- Tracks A–D: ~2 hours each, parallelisable → ~3–4 hours bounded by the
  slowest one.
- Track F: ~3 hours (the harness orchestrator is substantial code).
- Track E: ~1 hour (the test) + iteration on failures.
- Final: ~30 min.

Total: ~6–8 hours of autonomous execution.

---

## §6 — What Echo will NOT do autonomously

Truly Justin-only items, surfaced as **single Telegram message** if encountered,
with the work paused on that track only (other tracks continue):

1. **Revoke the leaked GitHub token** (from the 2026-05-27 incident). Echo
   surfaces the token prefix to revoke; Justin clicks revoke on the github
   settings page. (This is the ONLY genuine Justin-only item.)
2. **Approve any deviation from this spec.** If the implementation surfaces
   a design choice not enumerated here, Echo stops on THAT track only and
   asks (single Telegram message, plain English, with the choice + Echo's
   recommendation).

**NOT a Justin-only item (corrected 2026-05-27):** test bot acquisition.
Echo mints throwaway bots itself via @BotFather through the logged-in
Telegram browser profile, and drives Justin's real Telegram as the user
for the proving test. Echo never needs Justin to create or supply a bot
token. The earlier draft's "two bots via Secret Drop" ask was a
false-blocker and has been removed — see [[reference_telegram_access_via_playwright]].

---

## §7 — Stop conditions for the autonomous run

The autonomous-mode promise (`<promise>...</promise>` per the autonomous
skill) is only satisfied when ALL of the following are true on main:

- ✅ Tracks A–D each merged to main with all CI green
- ✅ Track F's `instar test-as-self` lands and `tsc --noEmit` clean
- ✅ Track E's `tests/e2e/cross-machine-seamlessness-live.test.ts` runs
  end-to-end and the JSON verdict report shows all 7 procedure steps PASS
- ✅ Track E step 7b (THE PROVING TEST) executed: Echo drove Justin's real
  Telegram against the live mmtest2 mesh, forced a handoff mid-exchange,
  and confirmed from the user-facing Telegram view that the reply arrived
  exactly once and the conversation continued seamlessly across machines.
  Screenshots/snapshots of the Telegram view captured as evidence.
- ✅ Final's PR (default-on flip) merged with CI green
- ✅ A summary report sent to topic 13481 listing what landed and the
  observed live-test latencies (lease transition, live-tail catch-up,
  exactly-once dedup overhead)
- ✅ Memory file written to `/Users/justin/.claude/projects/.../memory/`
  capturing the bootstrap lessons (so future bring-ups don't re-discover
  these gaps)

If any of these is not true, the run is incomplete and the stop hook
keeps Echo in autonomous mode.

---

## §8 — Out of scope (deliberate)

- Bob (mini :4040) is never touched; test agents are `mmtest2` only.
- Echo (workstation :4042) is never disrupted; everything runs in
  throwaway agent homes.
- The North Star "Continuous Working Awareness" surfacing fix (topic
  14828, the two surgical hook tweaks) is a separate spec, not bundled here.
- General publish-pipeline hardening beyond Track A's gate (e.g.,
  signed tarballs, provenance attestation) is its own spec.
- Mesh tunnel transport (Cloudflare tunnels for fast-path lease) is
  already on main per PR #428's `HttpLeaseTransport`; this spec uses the
  git-only substrate, which is the fallback path the live test must
  validate first.

---

## §9 — Open questions for Justin

Limited to truly Justin-only items:

- **Q1.** OK with this scope as a single autonomous run? Or split into
  two runs (Tracks A–D then E–Final)? **Echo's recommendation:** single
  run; the dependencies are tight and a split would just add a
  context-handoff cost.

- **Q2.** For the live-test bot acquisition (§6.1), is now a good time
  for Echo to ping you for the Secret Drop submission? Or queue it for
  whenever you're awake?

- **Q3.** When the final exactly-once-flip lands, do you want a Telegram
  ping at the moment it goes live on main, or only in the next-morning
  summary? **Echo's recommendation:** plain Telegram post when the
  release-cut PR lands ("cross-machine seamlessness is now live for all
  multi-machine agents"). It's a meaningful capability flip; users
  should know.

---

## §10 — Companion ELI16

See `MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC.eli16.md` (sibling file).
