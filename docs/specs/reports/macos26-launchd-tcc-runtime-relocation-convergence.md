# Convergence Report — macOS 26 launchd-TCC runtime relocation

**Spec:** `docs/specs/macos26-launchd-tcc-runtime-relocation.md`
**Author:** echo · **Converged:** 2026-05-28 · **Iterations:** 4 · **Reviewers/round:** security, scalability, adversarial, integration, lessons-aware (internal); external models skipped per abbreviated-convergence (lessons-aware ran every round, as required).

## ELI10 Overview

macOS 26 changed how the system protects your `~/Documents` folder. The background launcher that starts an Instar agent on login (`launchd`) no longer has permission to reach into Documents — so any agent whose startup files live there silently fails to start after a reboot, and because the agent never starts, none of its own self-repair runs. One agent (b2lead) sat dead and silent for two hours this way. Agents that live in `~/.instar` (like Echo) are unaffected.

This spec moves an agent's startup files into a safe folder the launcher can always reach (`~/Library/Application Support/instar/…`), makes the health-watchdog recognize this specific failure and page you about it, and makes the auto-updater survive a mid-update reboot. If it ships, agents stop dying silently from this; new agents are immune from the day they're set up; and an already-dead agent gets a clear page plus a one-time fix.

The main tradeoff the review forced into the open: **you cannot fully automate recovery for an agent that died *before* this fix existed.** The OS deliberately blocks every always-running background process from reaching into Documents — including the very thing that would do the move, and the thing that would grab the agent's Telegram token to page you. So a brand-new or already-relocated agent is fully protected and self-healing; an agent that died before ever running this code needs exactly one human action (click "Allow" on a permission prompt, or run one command), which both recovers it and arms it forever after. The spec says this plainly instead of pretending otherwise.

## Original vs Converged

- **"Fully automatic, zero touch" → an honest outcome matrix.** The first draft claimed b2lead would self-heal with no human action. Review proved that's physically impossible under macOS TCC. The converged spec states exactly which cases are zero-touch (new installs; already-relocated agents' future deaths) and which need one consented action (an agent that never ran the fix).
- **A new file holding every agent's Telegram token → no such file.** The first draft stashed all tokens in one machine-level file — exactly the shape of a past token-leak incident. Converged: a *minimal per-agent* credential (`{ownerTopicId, botToken}`) in a 0600 file outside any project git tree (or the OS Keychain as optional hardening), reused from the agent's own config — never an aggregate.
- **A migration that would silently do nothing → a migration that shouts when blocked.** The first draft's relocation would have run in the locked-out launchd context and failed to read the files it needed — silently. Converged: it probes whether it can read the source first; if not, it writes a loud marker and pages, never a silent no-op. It also can't leave a half-moved mess (build-aside, verify, atomic flip, completion sentinel written last) and uses an instant same-volume `rename()` instead of copying hundreds of MB.
- **A relocation that could fight the running server → stage-only on the common path.** Converged: when relocation runs from the launchd-spawned auto-updater (the common case), it only *stages* the new config and lets the next natural restart adopt it — no risk of two servers racing for the port.
- **Dead wiring → a migration mechanism that actually runs.** Review verified the spec's first mechanism (`registerStep`) is never called in production; converged uses a `migrate()`-body method that does run and has the data it needs.
- **Watchdog dependent on a healthy peer → autonomous paging.** Converged: the watchdog recognizes the exit-78 TCC failure specifically and pages you directly (for armed agents), only once per outage, with the token passed safely (never on the command line).

## Iteration Summary

| Iteration | Reviewers who flagged material findings | Material findings | Spec changes |
|-----------|------------------------------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, lessons-aware | ~12 critical/high + ~18 med/low | Central redesign: migrator-TCC-context honesty; whole-dir symlink + `--runtime-root`; plist logs off Documents; transactional move; drop token registry; exit-78 primary classifier; FDA probe-first; bounded `log show` |
| 2 | adversarial (2 CRIT), integration (2 CRIT) | 2 critical + ~6 high | Escalation spool + consented drain; `migrate()`-body method (not dead `registerStep`); two-layer pointer + consistency assertion; move-via-rename; markers pinned to non-TCC locations; hash-pinned root; CI-gate allowlist |
| 3 | adversarial (2 block), integration (2 block); lessons-aware CONVERGED | 4 blocking | Honest outcome matrix (irreducible-limit disclosure); minimal per-agent credential (file-default, Keychain→OQ); stage-only activation primary; relocate.json short-circuit first; cross-volume cause + OQ |
| 4 | adversarial (1 block: test labels); integration CONVERGED | 1 blocking (text) + 2 low | Relabel Tier-2/3 tests (armed vs genuine-b2lead); drop gitignore non-sequitur; surface `staged-not-yet-adopted` |
| 4-final | (confirmation) | 0 material | — |

## Full Findings Catalog (condensed)

**Round 1 — resolved:** plist node path + log paths under Documents (HIGH→fixed via `--runtime-root` + Library logs); aggregate token registry (CRIT security/lessons→dropped); migrator runs TCC-blind (CRIT adversarial/integration/lessons→honest matrix + EPERM probe branch); ~200-callsite blast radius (integration→whole-dir symlink + `config.stateDir` funnel + CI gate); shadow-install copy cost (CRIT scalability→move-via-rename); exit-78/`log show` brittleness (adversarial/lessons→deterministic primary + soft corroboration); FDA probe ordering (adversarial/lessons→probe-first); `log show` watchdog stall (scalability→bounded+cached); dual-live-copy split-brain (scalability/adversarial→move-not-copy, one live copy); structure-vs-willpower pointer resolution (lessons→funnel+CI gate).

**Round 2 — resolved:** escalation spool had no autonomous deliverer for headless single-agent (CRIT adversarial→per-agent credential armed pre-outage); `registerStep` dead wiring (CRIT integration, source-verified→`migrate()`-body method); resolver chicken-and-egg + symlink/arg disagreement (integration→two layers + boot assertion); npm-install offline containment (adversarial→same-volume rename, lockfile-pin cross-volume, retryable); markers under Documents unreachable by their actor (adversarial→pinned to `~/.instar`/Library/consented).

**Round 3 — resolved:** credential-arming itself TCC-trapped for dead-before-fix agent (CRIT adversarial→honest matrix: no autonomous page for never-armed; file-default read always works; one consented action arms it); Keychain-from-launchd unverified (adversarial→demoted to OQ3, file authoritative); stage-only activation framing inverted (CRIT integration→made primary path); relocate.json short-circuit ordering (integration→stated first + test); cross-volume needs network (adversarial→`relocate-needs-network` cause + OQ4); lessons-aware **CONVERGED** (1 low advisory→structural exclusion).

**Round 4 — resolved:** Tier-2/3 test labels still called the armed autonomous-page case "b2lead," re-encoding the overclaim in the test layer (MED adversarial, "tests can encode the bug as correct" lesson→relabeled armed-vs-genuine; honest assertions); gitignore non-sequitur for a non-git-tree path (LOW→clarified to perms+backup-exclusion+out-of-tree); unbounded staged-adoption window (LOW integration→`staged-not-yet-adopted` diagnosable state). Integration **CONVERGED**. Final adversarial confirmation: **CONVERGED**.

## Convergence verdict

**Converged at iteration 4.** All three load-bearing perspectives reached zero material findings: lessons-aware (round 3), integration (round 4), adversarial (round-4 final confirmation). Security and scalability findings from round 1 were all resolved and not re-raised. The spec is ready for user review and approval.

**Two items remain as user decisions at approval, both fail-safe (the silent-death fix ships regardless):** OQ1 (ship FDA in guided-System-Settings mode first, enable auto-prompt only after verifying the prompt fires on a real macOS 26.5 box) and OQ3 (Keychain is optional hardening behind a launchd-read verification; the 0600 file is the authoritative default). OQ2 (minimal per-agent credential at rest) and OQ4 (cross-volume layout) are informational confirmations.
