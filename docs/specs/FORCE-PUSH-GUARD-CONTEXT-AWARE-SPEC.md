---
title: Context-aware force-push guard
status: draft
initiative: force-push-guard-context-aware
author: echo
created: 2026-05-28
topic: 13201
approved: false
ships-staged: false
supervision: tier0
eli16-overview: docs/specs/FORCE-PUSH-GUARD-CONTEXT-AWARE-SPEC.eli16.md
amends-spec: []   # standalone fix — no prior spec amended
---

# Context-aware force-push guard — stop interrupting the user for the routine, safe case

> A fleet-wide one-shot fix: teach `dangerous-command-guard.sh` to recognize that `git push --force-with-lease` to a non-protected branch is provably safe and auto-allow it, while keeping the existing gate for the genuinely-risky cases (bare `--force`/`-f` without a lease, or force-push to a protected branch). Greenlit by Justin (topic 13201, 2026-05-28).

## 1. Problem — the safety guard cannot tell a safe push from a risky one, so every routine rebase-push interrupts the user

`.instar/hooks/instar/dangerous-command-guard.sh` (line 58, the risky-commands loop) pattern-matches `git push --force` / `git push -f` and, at `safety.level: 1` (the default), HARD-BLOCKS with an "Authorization required" error and exit 2. The substring match on `git push --force` ALSO catches `git push --force-with-lease`, because the guard has zero context.

The result: every agent session that needs to rebase its own feature branch and push it (the routine instar-dev workflow — rebase onto fresh main, then `git push --force-with-lease <remote> <branch>`) hits the wall and pings the user. Across the fleet, with many sessions, this is a daily Telegram interruption for the SAFE case. The dangerous cases — force-push to `main`/shared, or bare `--force` no-lease — don't actually happen in practice (no session targets `main`; with-lease is the established pattern).

This is the blunt-filter-vs-context (signal-vs-authority) anti-pattern in our own tooling: a brittle filter that has authority to block, with no context to distinguish safe from risky. The first concrete real-world catch surfaced by the (still-being-built) Correction & Preference Learning Sentinel.

**A second, adjacent false-positive discovered while authoring this spec (2026-05-28).** The risky-patterns loop runs `grep -qi "$pattern"` against the *entire* INPUT — so the literal string `git push --force` appearing ANYWHERE in the payload trips the BLOCK, including inside a `git commit -m "…git push --force…"` body, or a markdown file passed as a HEREDOC. Live-verified: committing this very spec, whose message body contained the matched phrase, was BLOCKED until the wording was changed. That is the same blunt-filter shape — no context for "is this token at command position or inside quoted text" — and the fix is in scope here (see §3.4).

## 2. What already exists (extend, not reinvent)

| Component | File | What it does | How this fix uses it |
|---|---|---|---|
| `dangerous-command-guard.sh` (template) | `src/templates/hooks/dangerous-command-guard.sh` | Shipped guard template; supports `safety.level` from `.instar/config.json`; level 1 BLOCKS risky commands, level ≥2 returns `decision:approve` with a self-verification prompt | **Edit the template.** Add a context-aware pre-check for `--force-with-lease` + non-protected target BEFORE the existing risky-patterns loop; on safe match, return `decision:approve` with an audit-trail context line and exit 0; on risky match, fall through to the existing logic unchanged. |
| `PostUpdateMigrator.migrateHooks()` | `src/core/PostUpdateMigrator.ts:1708` | `instar/` hooks are **always overwritten** on every migration (the documented post-`hook-event-reporter.js` lesson — install-if-missing causes ESM stalls). The migrator reads the in-binary `getDangerousCommandGuard()` template and writes it to `.instar/hooks/instar/dangerous-command-guard.sh` with mode 0o755. | **Zero migration code needed.** Updating the template is the migration; the next instar update overwrites every agent's deployed copy with the new logic. The Migration Parity Standard's "hook scripts → always overwrite" path applies exactly. |
| `ConfigDefaults` + `applyDefaults` deep-merge | `src/config/ConfigDefaults.ts` + `PostUpdateMigrator.ts:~207` | Adding a new field to `safety.*` automatically backfills existing agents on update via existence-checked deep merge. | The opt-out flag (`safety.alwaysGateForcePush`, default `false`) is added to `ConfigDefaults`. No hand-written `migrateConfig` block. |
| `.instar/config.json` `safety` namespace | already in use for `safety.level` | Established. | Add `alwaysGateForcePush` and `protectedBranches[]` here. |

**Verdict (own-feature-vs-extend): extend.** The guard already runs on every Bash tool call (PreToolUse hook); already has `safety.level`-driven branching; already supports a `decision:approve` JSON path (level ≥2). The fix is a 30–50 line addition to one template + a config-default field. Migration is free.

## 3. Design — pure determinism, no LLM

### 3.1 The decision logic (drop-in pre-check before the risky-patterns loop)

```text
if INPUT matches `git push` AND `--force-with-lease`:
   target_branch ← extract from refspec OR fallback to `git symbolic-ref --short HEAD`
   if target_branch is non-empty AND not in {protected branches list}:
       if safety.alwaysGateForcePush is FALSE (default):
           emit decision:approve  + audit context line  + exit 0
   else:
       fall through to the existing risky-patterns BLOCK / level-2-self-verify path
```

The default protected list is `{ main, master, prod, production, release/*, releases/*, prod/*, production/* }`. Operators can extend it via `safety.protectedBranches[]` (additive — defaults always apply).

If the refspec extraction returns empty (e.g. a `git push` form the regex cannot parse), the fix **falls through to the existing logic** (fail-closed: when in doubt, the safe default is the current behavior, not the new auto-allow).

### 3.2 Target-branch extraction (the only non-trivial bit, kept honest)

The command is one of:
- `git push --force-with-lease <remote> <refspec>` — extract `<refspec>`; the target branch is everything after the last `:` (`HEAD:branch` → `branch`; bare `branch` → `branch`).
- `git push <flags...> <remote> <refspec>` — same, ignoring flag tokens (`-u`, `--force-with-lease`, etc.).
- `git push --force-with-lease` (no refspec) — fall back to `git -C "${CLAUDE_PROJECT_DIR:-.}" symbolic-ref --short HEAD` (the current branch in the project dir; this is the established `INSTAR_DIR` resolution).
- Anything more exotic (multi-refspec, `--all`, `--mirror`) — refspec extraction returns empty; fall through to the existing logic.

A small bash helper does the extraction in pure POSIX shell + one `git` call. No external dependencies.

### 3.3 The opt-out

`.instar/config.json`:
```jsonc
"safety": {
  "level": 1,
  "alwaysGateForcePush": false,    // NEW — default false; flip to true to preserve old behavior
  "protectedBranches": []          // NEW — additive to the built-in protected list
}
```

For paranoid environments (a multi-user agent, an agent with broad push rights to shared infra), flipping `alwaysGateForcePush: true` restores the v1.3.x behavior (BLOCK on any force-push). Default off because (a) the auto-allow is only triggered by `--force-with-lease` (provably safe by git's contract: the lease refuses if the remote moved unexpectedly, so the push cannot clobber another contributor's work), AND (b) the protected-branch list keeps the dangerous cases gated.

### 3.4 Command-position anchoring (the live-discovered second false positive)

The existing risky-patterns loop runs `grep -qi "$pattern"` over the entire INPUT. This blocks any payload whose body merely *mentions* a matched phrase — including `git commit -m "…"` messages, HEREDOC bodies, and `cat` of any file whose contents happen to contain the phrase. Fix:

- **Tokenize the INPUT on shell operators** (`&&`, `||`, `;`, `|`, and unquoted-newline) to recover individual sub-commands. (Tokens inside `'…'` / `"…"` / `<<EOF…EOF` are skipped — the script uses a small POSIX state machine; full shell parsing is out of scope, but commit-message + HEREDOC body recognition is in.)
- For each sub-command, run the risky-patterns check against the **command verb + args region only**, not the quoted/HEREDOC body.
- For the new `--force-with-lease` auto-allow (§3.1), the same tokenization applies — it must see `git push` at command position in a sub-command, not embedded in text.

This change makes the *entire* risky-patterns family of checks context-aware to "the phrase appears at command position vs. inside a quoted body" — a generalization that benefits every pattern in the loop, not just `git push --force`. It is the smallest fix that closes the live-discovered second false-positive shape AND prevents the same anti-pattern from recurring on a future risky pattern.

**Fail-closed on tokenizer ambiguity.** When the tokenizer cannot confidently determine command position (e.g. complex `eval` constructs, indirect invocation via `bash -c "…"`), it falls back to the *existing* anywhere-substring behavior — BLOCK on any match. The new logic is strictly additive (it can only RELAX the existing block when it is *confident* about command position; it never adds a NEW block path).

### 3.5 Audit trail

When the auto-allow path fires, the `decision:approve` JSON `additionalContext` includes:
- The matched pattern (`git push --force-with-lease`).
- The resolved target branch.
- A one-line "why this is safe" explanation (the agent reads this; it's evidence in the Bash tool result for future review).
- The opt-out flag and how to flip it.

No new audit file is created; the existing Claude Code tool-result transcript carries the trace. (Adding a separate audit JSONL for guard auto-allows is deferred — `instar/hook-audit.jsonl` could be a future cross-feature primitive, but is out of scope here.) <!-- tracked: force-push-guard-context-aware -->

## 4. Boundaries (what this is NOT)

- Not a relaxation for bare `--force` / `-f` (no lease) — those continue to block at level 1.
- Not a relaxation for force-push to a protected branch — those continue to block regardless of `--force-with-lease`.
- Not a relaxation of any other risky pattern (`rm -rf .`, `git reset --hard`, `DROP TABLE`, etc.) — the existing logic is unchanged for non-`git push` patterns.
- Not a context-aware gate for the deployment commands (`vercel deploy`, `npm publish`, etc.) — those go through the Coherence Gate path, which is correct and unchanged.

## 5. Lifecycle / rollback / privacy

- **No staged rollout.** This is a guard relaxation, not a new sentinel/poller — there is no `enabled` flag with phased adoption. The default ships as the fix (`alwaysGateForcePush: false`); operators opt out per-agent if needed.
- **Rollback** = set `safety.alwaysGateForcePush: true` in `.instar/config.json` (per-agent), OR revert the template change (fleet-wide).
- **Privacy** = N/A; the guard sees only the command string the user/agent already issues. No new data is captured or persisted.

## 6. Open questions (for convergence + user)

1. **Default-on the fix vs. ship-with-opt-out + change default later?** The spec proposes **default-on** because the daily-friction-cost across the fleet is real and the safety-cost is small (lease + non-protected). Confirm.
2. **Protected list — include `develop` / `staging`?** Spec proposes a minimal built-in list (`main`/`master`/`prod`/`production`/`release/*`/`releases/*`/`prod/*`/`production/*`) and additive `safety.protectedBranches[]` for operator extension. Adding `develop`/`staging` to the built-ins would protect more environments by default but punish projects that use those as their working branches. Default minimal; let operators extend.
3. **Empty-refspec fallback — `symbolic-ref` from `CLAUDE_PROJECT_DIR` or the cwd of the Bash invocation?** Spec proposes `CLAUDE_PROJECT_DIR` (the documented INSTAR_DIR resolution at the top of the existing guard). Worktrees correctly resolve their `.git` gitlink, so the symbolic-ref returns the worktree's branch.

## 7. Testing (3-tier, NON-NEGOTIABLE)

- **Unit (bash test harness or shellcheck-friendly invocation)** — both sides of every decision boundary on synthetic inputs:
  - `git push --force-with-lease JKHeadley feat/x` → auto-allow (target=`feat/x`, non-protected). Asserts `decision:approve` JSON shape + exit 0.
  - `git push --force-with-lease JKHeadley main` → BLOCK (target=`main`, protected).
  - `git push --force JKHeadley feat/x` → BLOCK (no lease).
  - `git push -f JKHeadley feat/x` → BLOCK (no lease, short flag).
  - `git push --force-with-lease JKHeadley release/v3` → BLOCK (`release/*` protected).
  - `git push --force-with-lease JKHeadley HEAD:feat/x` → auto-allow (target=`feat/x` after `:`).
  - `git push --force-with-lease` (no refspec, current branch is `feat/x`) → auto-allow via symbolic-ref fallback.
  - `git push --force-with-lease` (no refspec, current branch is `main`) → BLOCK via symbolic-ref fallback.
  - `git push --force-with-lease` with `safety.alwaysGateForcePush: true` → BLOCK (opt-out honored).
  - `git push --force-with-lease --all` (multi-refspec form) → refspec extraction returns empty → fall through → BLOCK (fail-closed).
  - Operator-extended `safety.protectedBranches: ["develop"]` + push to `develop` → BLOCK.
  - Non-`git push` risky pattern (`rm -rf .`, `git reset --hard`) → BLOCK unchanged (regression guard).
- **Integration** — exercise the migrator: `migrateHooks()` overwrites an existing `.instar/hooks/instar/dangerous-command-guard.sh` with the new template content (always-overwrite path).
- **E2E** — exec the deployed hook with each of the synthetic inputs above (via the Claude Code tool-result JSON contract) and assert the response. Pin the protected-list defaults via the same fixture.
- **Wiring-integrity** — the new pre-check is a strict ADDITION (the existing pattern loop is unchanged); a snapshot test pins that the existing patterns block bytes-identically.

## 8. Migration parity

- **Template** — edit `src/templates/hooks/dangerous-command-guard.sh`. The migrator reads it via `getDangerousCommandGuard()` and overwrites every existing agent's `.instar/hooks/instar/dangerous-command-guard.sh` on the next update. Built-in `instar/` hooks are always-overwrite (no install-if-missing trap). No hand-written `migrateHooks` block needed.
- **Config defaults** — add `safety.alwaysGateForcePush: false` and `safety.protectedBranches: []` to `src/config/ConfigDefaults.ts`. `applyDefaults`'s existence-checked deep merge backfills existing agents automatically.
- **CLAUDE.md template** — small awareness note under the existing "No Interactive CLI Commands" / safety section: agents may now `git push --force-with-lease` to non-protected branches without prompting; `safety.alwaysGateForcePush: true` restores the old behavior. Add the same content-sniffed block to `migrateClaudeMd` for existing agents.
- **`upgrades/NEXT.md`** — required (3 sections), keeps the `feature-delivery-completeness` test green.
- **`upgrades/side-effects/force-push-guard-context-aware.md`** — seven-dimension review artifact.

## 9. Success criteria

- A `git push --force-with-lease` to a feature branch on an updated agent completes WITHOUT a Telegram prompt — observable as zero `BLOCKED:` lines in `hooks/dangerous-command-guard` invocations on a session that did a routine rebase-push.
- A `git push --force JKHeadley main` continues to BLOCK identically (regression guard).
- `safety.alwaysGateForcePush: true` restores v1.3.x BLOCK-on-all behavior.
- The acceptance fixture: a fresh Echo session can rebase its own feature branch and `git push --force-with-lease` it with zero user prompts at default safety.
- 3-tier tests green; existing safety.level-2 self-verification path remains intact and untouched.

## 10. Config (defaults safe; opt-out, not opt-in)

```jsonc
"safety": {
  "level": 1,
  "alwaysGateForcePush": false,
  "protectedBranches": []
}
```

Built-in protected branches (always apply; not config-controlled): `main`, `master`, `prod`, `production`, `release/*`, `releases/*`, `prod/*`, `production/*`.

## 11. Slice plan

- **Slice 1 (the whole fix):** template edit + config defaults + CLAUDE.md awareness + migrateClaudeMd block + 3-tier tests + NEXT.md + side-effects. One PR.
- **No Slice 2** required — this is a one-shot context-aware relaxation, not a phased feature.

## 12. Finding ledger (convergence rounds)

_(populated during /spec-converge)_
