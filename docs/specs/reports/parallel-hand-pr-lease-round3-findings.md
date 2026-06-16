# Parallel-Hand PR Lease — Round 3 findings (consolidated)

Round 3 reviewers (on the v3 / round-2 rewrite): 2 combined internal (security+adversarial; decision-completeness+lessons-aware+integration) + external codex-cli/gpt-5.5 (MINOR ISSUES). Round-2 resolutions (M-B, M-D, §3.5, §3.1) all verified SOUND. No blocker; remaining items mechanical (convergence trend: R1 3 blockers → R2 1 blocker → R3 0 blockers).

## Net-new (all applied in v4)

- **HIGH (security+adversarial) — chokepoint completeness overstated.** The PreToolUse Bash hook catches *literal* `git push` (the #1183 shape) but is bypassable by script-body / git-alias / string-obfuscation. FIX: not chase evasions — STATE them as accepted residual evasions of a COOPERATIVE guard (§7), in §2 non-goals + §3.4. (codex#1 R3 corroborated from the parsing angle: handle `cd &&`, `git -C`, env-prefix, `command git push`, multiline — the hook matches the full command like dangerous-command-guard.sh.)
- **MEDIUM (decision+integration) — hook OWN-crash must fail-OPEN.** A PreToolUse hook exiting non-zero for ANY reason blocks the push; a crashing guard would block EVERY push (worse than the thrash; the hook-event-reporter.js lockout class). FIX: wrap the whole hook body in try/catch → any uncaught error → exit 0 (ALLOW) + log. Test.
- **MEDIUM (codex#2 R3) — canonicalization should delegate to git's OWN resolution**, not reimplement push.default/pushRemote/remote.<name>.push. FIX §3.1: derive the destination ref via `git push --dry-run --porcelain` in the push cwd; fail-open on ambiguity.
- **MEDIUM (codex#3 R3) — max-hold ceiling vs long legitimate work.** Force-releasing a LIVE same-machine holder at 90m reintroduces competition (a big rework + slow CI can exceed 90m). FIX §3.9: discriminate on liveness — DEAD/foreign-unverified past ceiling → CAS-seize + attention; LIVE same-machine past ceiling → DENY second hand + escalate (operator decides), never auto-seize.
- **MEDIUM (security) — §3.3 "inherited verbatim" overstated.** ResumeQueue has the lock+persist+FD1/2/4/5 but NOT per-record CAS — that's new (sound) logic. FIX: reword; the per-record CAS under the lock is a small new addition, which is why the race tests are load-bearing.
- **MEDIUM/LOW (codex#4 R3) — dryRun still mutates shared lease state.** A dryRun lease could perturb the MergeRunner soft-hold. FIX §5: a dryRun lease carries a `dryRun:true` marker that ALL non-acquisition readers (esp. MergeRunner soft-hold) ignore → zero behavioral effect. Test.
- **LOW/MEDIUM (integration) — §8 denylist present-tense + unnamed symbol.** FIX: imperative "build MUST add state/pr-hand-leases.json to `BackupManager.BLOCKED_PATH_PREFIXES` + test."
- **LOW (integration) — migrateSettings not named (only migrateHooks).** A hook file not REGISTERED in an existing agent's settings.json never fires. FIX §4: name `migrateSettings()` idempotent Bash-entry add + `settings-template.json` for new agents.
- **LOW (integration) — per-push latency invariant.** FIX §4/§6: hook does a single local JSON read, NO HTTP/subprocess on the fresh-lease path; lint/test locks it against regression.

## Verified SOUND (no change)
§3.1 canonicalization is collision-correct both directions; §3.5 cross-machine precedence (maxHold overrides foreign-conservatism, bounded + loud) is a correctly-scoped accepted residual; M-D forced-release-via-CAS consistent. §10 Open-questions clean (none-marker); no new user-decision introduced; lessons (ResumeQueue FD, Structure>Willpower via the hook, Signal-vs-Authority §7) correctly inherited.

## Round-4 status
v4 folds all of the above. Convergence trend strongly positive; round-4 verification pending.
