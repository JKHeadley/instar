# Convergence Report — Disk Steward

## ⚠ Cross-model review: codex-cli:gpt-5.5 (via direct `codex exec`; the review script reported degraded: error)

GPT-5.5 reviewed the spec in rounds 2–6 through the agent's own Codex login. The `cross-model-review.mjs --family codex-cli` path returned `degraded: error` with no message in round 1 (twice), while `codex exec` itself worked. So each round's external read was run directly with the same instructions and a read-only sandbox. That defect is filed as fb-48977ece-989. Gemini was not signed in on this machine.

## ELI10 Overview

On 7 November the Mac Studio's disk got 95% full and the Instar app refused an upload. Nobody had been warned. This change gives every machine a small watcher inside the agent's server. It checks free space every 15 minutes and works out how fast space is shrinking. When space gets low it first clears two kinds of safe tool cache (npm's download cache and Xcode's build files), then posts plainly in a "Disk space" topic if space is still low. Every post names the machine and says what can be done. Standby machines never post themselves: the awake machine reads their numbers and posts for them, so the chat has one voice.

It also fixes two leaks found that day. Local Verify now removes its own leftover test copies at the start of each run. The worktree cleaner no longer treats linked dependency folders, or build output it can prove came from the source, as unsaved work.

The tradeoff: the cleanup is deliberately narrow. Review kept finding ways a broader cleaner could delete something that mattered. The most serious was on this exact machine: 189 worktrees share one installed dependency folder through links. So anything that cannot be proven safe is kept, and the posts say what is being kept and why.

## Original vs Converged

- **Started:** a broad cleaner (worktrees, test copies, Xcode, simulators, Homebrew, npm) that the watcher ran itself, plus a standby-to-holder relay that posted the standby's own text.
- **Now:** two caches only, run in a separate time-limited process. The worktree cleaner keeps its own switch. Simulators and Homebrew are dropped, because deleting a simulator deletes its app data and `brew cleanup` deletes old installed versions a running process may use.
- **Clean before warning:** the watcher now cleans before it warns, and stays quiet if that fixed it. A growth forecast can make a warning more urgent but can never trigger deletion.
- **Standby posts:** standbys never send. The awake machine writes every post from numbers, so no machine can inject text.
- **The worktree rules were rebuilt three times** as review found real hazards:
  - the session lock records the server's process id, not the session's (that lock fix is now its own item, fb-f564e836-6ca);
  - a real dependency folder may hold hand edits;
  - worktrees link into each other in chains, and the 2.0 pipeline links into worktrees;
  - `dist/` must be proven to be build output, file by file and within one build window.
- **Local Verify's sweep** touches only folders the verifier named and registered, and that no process is using.
- **The urgent ("critical") tier:** delivers on every agent, posts once per episode, and retries without being swallowed by the notification gate's deduplication.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, adversarial, integration, scalability, decision-completeness, lessons, standards gate | ~25 | 6 | Rewrite: heal-then-notify, forecast never deletes, holder relay, child process, lock and sweep holds |
| 2 | all internal + GPT | ~28 | 5 | **Scope cut**: two caches only; dropped lock retirement, simulators, Homebrew |
| 3 | all internal + GPT | ~18 | 6 | Holder-pull posting, critical state, per-volume check, observed-recovery forecast, test-agent rung |
| 4 | all internal + GPT | ~10 | 6 | Linked-only `node_modules` (real folders kept), at-least-once delivery, offer only when clearable |
| 5 | all internal + GPT | ~12 | 5 | Inbound-link index, `dist/` provenance, Local Verify run-id/registered/idle checks, critical once per episode |
| 6 | integration (4), data-loss (4 + 2 low), GPT (7) | 15 | 8 | All fixed in code with tests and in the spec text (no seventh round: Tier-2 cap) |

Standards-Conformance Gate: ran in rounds 1 and 3 (round 1 first attempt unavailable: timeout after 90 s; retried and returned 4 flags on round 1 and 6 flags on round 3, all folded in or answered in the decision rows). Not run in rounds 2, 4, 5 and 6: each run took 10+ minutes and the round's reviewers covered the same standards.

Internal reviewer models: the six lenses were run as two or three combined reviewer subagents per round on the authoring session's model (Opus 5.5).

## Proportion

Tier 2. Spec about 260 lines. 6 of 6 rounds used. ⚠ Out of line for the original brief's size. The cause was a real one: the deletion rules had to be fitted to this machine's actual layout (shared dependency links, pipeline links, generated files). Two scope cuts brought the design findings down from about 28 to about 10. They never reached zero inside the cap.

## Left behind

- Session-lock retirement (23 worktrees, ~14 GiB): the lock cannot prove its session ended. Tracked: fb-f564e836-6ca.
- Other ignored leftovers that keep most worktrees (`.husky/_`, generated `src/data`, `.instar/audit`, `.vitest`, `logs`, `data`) and real `node_modules` folders. Tracked: fb-4ee99a20-35b.
- Links into a worktree from outside the scanned folders (another agent's home, inside a real `node_modules`) are not seen. None found on the Studio.
- An npm subprocess that outlives a crashed prune child is not killed; it ends on its own.
- Hand edits inside a Local Verify run checkout are not protected beyond git's own check (run checkouts are disposable).
- A rare duplicate post on a lease move (at-least-once delivery).
- A cache deletion racing a just-started build can fail that build once (rerun).
- A Telegram inline "Clear now" button was suggested. The reply path is used instead, because no generic button-callback route exists for automated posts.
- Several agents on one Mac each post in their own topic. If two agents share one operator group, they post the same disk fact twice.
- The 2.0 desk/preview pipeline retention, the largest user of space, is raised with its owner separately.

## Full Findings Catalog

Each round's raw findings are in the session transcript of topic 140571 (2026-11-07 16:16–17:20 PST). The design-class findings and their resolutions are summarized per round in the Iteration Summary and Original vs Converged above. Every round-6 finding maps to a named test in `tests/unit/agent-worktree-reaper.test.ts`, `tests/unit/localVerify/orphanSweep.test.ts`, `tests/unit/diskSteward-pruneCategories.test.ts` or `tests/unit/diskSteward-levels.test.ts`.

## Convergence verdict

Converged at the round cap, with a caveat. Round 6 still raised design findings: 15, none of them high-severity data loss. Each was fixed in code with a test and in the spec text, but no seventh round confirmed a quiet pass. The remaining items are declared limits listed above. The approver should weigh that caveat before approving.
