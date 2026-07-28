# Convergence Report — Playwright Profile Registry + Account-Access Awareness

## ⚠ Cross-model review: UNAVAILABLE

No supported external (non-Claude) reviewer pass ran for this convergence. Reason:
`worktree-build-env-split` — the fresh `git worktree` has no `node_modules`/`dist`, and
the agent-home runtime checkout has `dist` + `node_modules` but not the `skills/`
cross-model harness, so `cross-model-review.mjs` could not be assembled without a full
`pnpm install` in the worktree (disproportionate for the external pass). codex AND
gemini ARE installed on this machine, but the harness was unrunnable in-context. The
durable framework-activation history (`state/framework-activation-history.jsonl`) is
absent, so the Phase-3 mandatory-check (`wasNonClaudeFrameworkActiveWithin(7)`) does NOT
require externals — recording `unavailable` is legitimate, not a skip. Convergence ran
on the SIX internal Claude reviewers + the code-backed Standards-Conformance Gate.
(Remediation for a future pass: run convergence from a worktree with deps installed, or
wire a shared dist/harness path.) This matches the P1/P2 specs merged earlier this run.

## ELI10 Overview

The agent unblocks itself by driving a real web browser logged into real accounts
(Justin's Google, the agent's own Google, a GitHub session). The passwords are in the
agent's encrypted vault; the browser "who am I logged in as" lives in a profile folder
on one machine. Until now there was no organized record of which profile holds which
account, and nothing told the agent at session start what browser access it has — that
knowledge existed only as ~21 scattered, contradictory notes, which caused the agent to
ask the operator to act instead of unblocking itself.

This change adds a tidy, durable registry of browser profiles, each describing the
accounts it owns (by the vault secret's NAME, never the secret), a short awareness
pointer injected at session start, and commands to create a profile, attach an account,
pick the right profile for a task, and switch the browser onto it. It ships off for the
fleet and live only on the dev agent, the switch command starts in a safe dry-run mode,
and no passwords are ever stored or shown.

The main tradeoff the review settled: the registry owns the data, awareness, selection,
and the switch; the actual interactive login (typing a password, a phone code) stays the
agent's job, because that step can't live in a fixed command. Everything that CAN be a
clean command is in the change.

## Original vs Converged

Originally the spec described the "switch profiles" command as *rewriting an existing
`--user-data-dir` setting in `.mcp.json`*. Review found that **factually wrong against
the live system**: the Playwright MCP server is configured in BOTH `.mcp.json` and
`.claude/settings.json` with **no `--user-data-dir` setting at all**, and the folder the
original spec named (`.playwright-mcp`) is the browser's *output* folder, not its login
profile. The converged spec fixes this: a single shared resolver finds whichever config
file the browser actually reads (preferring `.claude/settings.json`), the switch command
*inserts* the setting when absent (and removes it to restore the default), and the
default profile is recorded as "the browser's built-in location," not the wrong folder.

Originally the switch command performed a live config write + session restart with no
safety mode. Review found this violated the convention every other sensitive command
follows. The converged spec ships the switch in **dry-run by default** (it logs what it
*would* change and restarts nothing) until explicitly enabled — matching
`credentialRepointing` / `topicProfiles`.

Originally the registry would have re-created the exact "contradictory stale notes"
problem it exists to fix: a `loggedIn: true` flag with no decay, presented at boot as
fact. The converged spec renames it `lastAsserted`, renders its AGE ("seen 2d ago" /
"unverified"), frames it as advisory-not-authority, and requires the agent to re-verify
before any privileged action. It also adds an `owner: agent|operator` label on every
account (Know Your Principal — so the agent never acts as the operator unbidden), an
append-only audit log of every write, single-writer concurrency, a path-jail on profile
folders, sanitize-on-render against prompt-injection, fail-closed credential-name
validation, and a compact boot pointer (full detail behind a route) so the always-loaded
context doesn't bloat.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware | ~17 (2 hard blockers: M1 no-dry-run, M2 missing-arg false-premise) | Comprehensive rewrite: shared config resolver (D10), dry-run activate (D5), staleness honesty (D11), owner field (D12), CAS (D14), corrupt-fail-closed (D15), sanitize-on-render (D16), fail-closed refs (D17), ambiguous-resolve (D18), loop-guard (D19), audit log (D20), compact boot pointer (D21), fail-open fetch (D22), userDataDir jail (D9), cardinality caps (D13), corrected migration mechanism (getSessionStartHook, not HTTP_HOOK_TEMPLATES) |
| 2 | (convergence check — 3 verifiers covering all 6 perspectives) | 0 material (all round-1 findings RESOLVED; 2 advisory hardening notes folded in) | Audit-log sanitize-on-surface note (D20); owner-is-advisory note (D12) |
| — | (converged) | 0 | none |

Standards-Conformance Gate: ran both rounds (0 at-risk flags).
Cross-model: unavailable both rounds (see banner); not mandatory (no activation history).

## Full Findings Catalog

**Round 1 — Security:** (#1/#2 HIGH) `.mcp.json` rewrite underspecified + userDataDir
traversal/arg-injection → D10 exact two-element mutation + D9 path-jail. (#3 MED)
boot-block prompt-injection → D16 sanitizeForBlock on every rendered field. (#4 MED)
ref-validation fail-closed + no-value invariant → D17 + D3 negative test. (#5 LOW)
plaintext recon-map → at-rest honesty note. (#6 LOW) restart-loop → D19 + already-active
no-op.

**Round 1 — Scalability:** (HIGH) lost-update race ("writeConfigAtomic" not safe) → D14
single-writer CAS. (HIGH) boot fetch no timeout/fail-open → D22. (MED) corrupt JSON →
D15 fail-closed-write/fail-open-read. (MED) no cardinality cap → D13. (LOW) byte-bound
account-line truncation → D21. (LOW) read-time ref staleness → D17.

**Round 1 — Adversarial:** (#1 HIGH) unattributable poisoning → D20 audit. (#2/#3 HIGH)
stale `loggedIn` + authority ambiguity → D11 staleness + advisory framing. (#4 HIGH)
unbounded identity-switch → D5 dry-run + D19 + un-bypassed gates. (#5 MED) empty-profile
boot → dirExists. (#6 MED) wrong-identity resolve → D18 ambiguous. (#7 MED) dangling ref
→ D17. (#9 MED) userDataDir containment → D9. (#10 LOW) truncation hides privileged →
D21 stable order. (#8 LOW) at-rest exposure → honesty note.

**Round 1 — Integration:** (#1 CRITICAL) wrong hook mechanism (HTTP_HOOK_TEMPLATES) →
corrected to `getSessionStartHook()` (verified at PostUpdateMigrator.ts:8479; always-
overwrite at 2854). (#2 CRITICAL) activate edited wrong file → resolvePlaywrightMcpConfig
prefers `.claude/settings.json`. (#3 CRITICAL) default userDataDir resolution wrong →
D10 null=built-in. (#4 HIGH) MCP-autorefresh double-restart + seed-must-be-metadata-only
→ D19 coordination (autorefresh loop-guard verified at 8442+) + metadata-only seed.
Dev-gate wiring, multi-machine posture, agent-awareness, rollback: confirmed sound.

**Round 1 — Decision-Completeness:** M1 (BLOCKER) no dry-run on identity+config write →
D5. M2 (BLOCKER) missing `--user-data-dir` arg false premise → D10. M3 (MINOR) no
dir-exists check → dirExists. D8 (login-is-agent-action) contested and UPHELD as a
legitimate layer boundary. CMT-1554 cross-machine deferral: legitimate, tracked.

**Round 1 — Lessons-aware:** S1 (foundation contradiction — arg doesn't exist) → D10.
S2 (wrong migration artifact) → getSessionStartHook. S3/L1 (boot-bloat) → D21 compact
pointer. S4 (loggedIn staleness) → D11. B2 (Know Your Principal — owner) → D12. F1
(shared-profile regression) → metadata-only seed. F2 (divergent source-of-truth) →
single resolver. B1 (untrusted-signal framing): confirmed done right.

**Round 2 — Convergence check (3 verifiers, all 6 perspectives):** all round-1 findings
verified RESOLVED against the revised spec AND the live source. Two advisory notes
(non-blocking) folded in: (a) audit-log fields must pass sanitizeForBlock if ever
surfaced into a context block; (b) `owner` is an advisory self-assertion, not a verified
principal. No new material findings. All three verifiers: "CONVERGED (no material
findings)."

## Convergence verdict

Converged at iteration 2. No material findings in the convergence-check round; the two
advisory hardening notes were folded in without introducing new questions. `## Open
questions` is `*(none)*`. Spec is ready for approval (this is a pre-approved autonomous
run; the author applies `approved: true` per the run's standing operator pre-approval).
