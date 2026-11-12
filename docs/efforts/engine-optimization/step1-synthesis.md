# Step 1 synthesis: engine-feature research and brainstorm

**Process.** The three researchers were Echo (Claude Opus 5.5), Fable 5.2 (same family as Echo, so a clean-door read) and GPT 6 Astra (a different family).

- **Phase A was sealed.** Each researcher answered the same question-only packet alone (`step1/research-packet.md`, sha256 ddefe441…). Echo's answer was sealed at 22:32:22Z (sha256 45d704c7…), before either outside run began. *Correction (post-review): this was before the packet was frozen, and Echo's answer does not follow the packet's Q1–Q8 shape. It is independent, but it did not follow the same protocol. The packet header says 22:35Z, but the file was written at 22:33:21Z.* The ranked part of the March audit was held back.
- **Phase B was a cross-critique.** Each researcher read all three Phase A answers plus the full March audit, then settled factual conflicts using evidence.
- **Receipts** (sha256 of each output):
  - phaseA-fable-5-2.md: cefded73…
  - phaseA-gpt-6-astra.md: 15828a68…
  - phaseA-echo.md: 45d704c7…
- **Code and engines.** The code read was main at 3ae8208a6. The engines installed here are Claude Code 2.1.322 and codex-cli 0.167.0. Gemini, pi and Grok are supported in code but not installed on this machine.
- **Degraded runs.** The machine's stuck-process guard interrupted Fable's Phase A twice and one helper process of Astra's run once (fb-b2aa22d0-32a). Fable's Phase A was rerun in full (the interrupted run had exited 0 with no output). Astra's run completed without a redo; only a helper process was killed. The work that was interrupted, and what it cost, is not fully accounted for.

## What all three agree on (after Phase B)

1. **The kill check passes on testable benefit.** Each researcher named different examples. Echo named fallback, least privilege and structured output. Fable named effort, fallback and Codex compaction hooks. Astra named Gemini usage and scoped launches. All three agree that at least one feature has a benefit that can be tested with data Instar already collects. No benefit has been *measured* yet, and none of the three researchers ran a model-backed feature live.
2. **Instar already has the skeleton; it isn't wired in.** It has capability flags for each adapter (`src/providers/capabilities.ts`), a registry and a routing policy. But real sessions start through `src/core/frameworkSessionLaunch.ts`, which branches on each engine directly. Engine checks are spread across the code: about 356 comparisons in 95 files, 54 of them in SessionManager. The Codex and Gemini adapters are not even registered in production (`providers/bootRegistration.ts`). **Rule 30 is not met today, and nothing checks it.**
3. **Build no new subsystem** (Rule 116). Callers state a neutral *intent* (effort, a fallback, a tool scope, an output schema), and each engine's code turns that intent into its own flags or drops it with a reason. The existing `thinkingMode` → `--effort` / `model_reasoning_effort` mapping is the pattern to copy.
4. **Before/after claims need a per-run record first.** Each record would hold the CLI version, the features asked for, the features applied, the features dropped, and why. No such record exists (`JobRunHistory` has no CLI version).
5. **The advisor is reachable on a subscription.** It works through Claude Code's own setting (`advisorModel` / `--advisor`, version 2.1.260 or later), with no raw API call (code.claude.com/docs/en/advisor). It is also experimental, gated by a remote feature flag, and has no cap on calls. It was never tried live. Availability on Echo's account is UNRESOLVED. A Fable advisor can bill to usage credits on some plans, so it must never be selected by default (Rule 122). It also depends on the model and the account. So it is a bounded experiment on a dev agent, not a rollout.
6. **Discovery must never start work by itself.** Both candidate homes have an automatic path that can act on its own:
   - `EvolutionManager.processProposalAutonomously` (`:1072`) can approve proposals by itself.
   - The Ecosystem pipeline's `agentStartSpec()` (`EcosystemIdeaService.ts:640`) can launch a spec session.

   Whichever home is chosen needs an enforced "owner charter required" lock on every path that can start work.

## Facts settled in Phase B (corrections to individual surveys)

*Items marked (1 source) were raised by a single researcher in Phase B and have not been checked by anyone else yet. Step 2 verifies each one it relies on.*

- `--bare` never reads OAuth, so it can't be used on a subscription and doesn't ship. This corrects Echo.
- Codex `--output-schema` is implemented in the adapter, but nothing in production reaches it. This corrects Fable and Echo.
- The March audit's "Codex warm RPC in use" claim is overstated: the cited files are interface docs, and Codex input still goes through tmux.
- The Doorway scan probes versions and model lists, not `--help` output. This corrects Echo.
- Per-job effort is half built. The headless launch options already accept `effort`; nothing in the scheduler passes it.
- (1 source: Fable) 36 of the 40 built-in job templates use `toolAllowlist: "*"`. Least privilege is mostly a job-classification task, and (1 source: Astra) `JobScheduler.ts:4735` already has the enforcement semantics.
- `--fallback-model` covers overload and unavailability, not account quota. It must skip jobs whose model was pinned on purpose.
- (1 source: Astra) Prompt snapshots are already Claude's default, so any optimization has to beat that baseline.
- Codex compaction hooks are unresolved: they need a live probe against the installed version.

## Ranked opportunities (merged; every item has a fallback)

| # | Opportunity | Engine(s) | Fallback on other engines | How to measure | Size | Needs |
|---|---|---|---|---|---|---|
| 1 | **Launch intent + per-run feature record**, proven with **per-job effort** | Claude, Codex (others drop the intent and record why) | Intent dropped and recorded as `not-supported`; default behaviour unchanged | share of runs with a complete record; tokens per run vs Jev grade for matched jobs | S–M | — |
| 2 | Model fallback chain, skipped for pinned-model jobs | Claude | Instar's own swap, breaker and RateLimitSentinel | overload-lost sessions; grade after fallback | S | 1 |
| 3 | Never-prompt headless | Claude (Codex already uses `never`) | prompt watchdog | permission stalls per week | S | 1, plus a stall-table row |
| 4 | Least privilege for judgment-only jobs (reclassify the 36 `"*"` jobs) | Claude tools, Codex sandbox | external confinement; a job that *requires* confinement declines to run rather than running unrestricted | forbidden effects blocked; legitimate completion rate | M | 1 |
| 5 | Native structured output for gate calls | Claude now, Codex after 6 | validate, plus one bounded repair | malformed-output rate per feature | S–M | 1 |
| 6 | Register the Codex and Gemini adapters for one-shots; Gemini JSON usage | Codex, Gemini | legacy providers; explicit unknown usage | usage coverage | M | — |
| 7 | Codex compaction hooks | Codex | rollout parsing | Context Budget sentinel moves `counted` → graded | M | live probe |
| 8 | Scoped MCP startup, applied consistently | Claude, Codex | current approved MCP set | startup p95; missing-tool failures | M | 1 |
| 9 | Engine discovery: daily help/version hash, changelog read on a version change, weekly floor, owner-charter lock on every start path | all enabled | manual digest | seeded changes detected; zero unauthorized starts; no-change receipts | M | 1 |
| 10 | Advisor shadow A/B on a dev agent | Claude | ModelTierEscalation, or the capable tier | grade, total usage and latency vs effort-only and stronger-model baselines; plan usage delta | M | 1, 2, live canary |

**Alongside #1:** a **Rule 30 ratchet lint** that holds engine-name comparisons outside adapters at today's count, so the leak can't grow. It is size S.

**Backlog (filed, not ranked):** a session-to-branch / merge-back record and cross-machine hook forwarding (both from the March audit); a plugin bundle; cheap subagents; classifier permission modes; Grok update suppression.

## The first sub-effort (step 2)

**#1, launch intent plus the per-run feature record, proven with per-job effort.** It combines Fable's choice (the record) and Astra's choice (per-job effort through one adapter-owned seam):

- one neutral `effort` field on the job definition, passed by the scheduler;
- a neutral intent on the launch options; each engine's translation lives in that engine's own module, which the launch builder calls (Rule 30 for new code);
- each builder returns what it applied and what it dropped, and a per-run record joins that to the run id;
- the ratchet lint;
- when the field is left out, behaviour is unchanged.

Out of scope: moving the 1,400-line launch file and registering new adapters.

## Owner-level questions (charter decision 5): sent to Justin 2026-11-11

*Correction (post-review, both outside reviewers): an earlier version listed several of these as "Decisions Echo made". Charter decision 5 gives them to Justin. Each one below has Echo's recommendation, which is the working default until he answers. The step-2 spec is designed so that any of his answers is a small edit.*

| # | Question | Raised by | Echo's recommendation (working default) |
|---|---|---|---|
| 1 | Sentinels (as your ask says), or a static per-engine declaration checked at launch? | all three | Static declaration; add a sentinel only when a decision varies mid-session |
| 2 | When does the advisor get tried? | all three | A capped trial on the dev agent once the launch record exists; never a credit-billed advisor by default |
| 3 | Where does new engine-specific code go? (a) Leave the launch builders where they are and add a ratchet lint. (b) Move only the code a change touches into each engine's adapter module. (c) Move everything now | Fable (a), Astra (b) | (a) for this first slice, with the lint baseline covering everything outside the adapters. The launch module gets its own lower ceiling, so it can't grow either. Revisit for the next slice |
| 4 | Is testable benefit enough to pass the kill check, or is a measured before-and-after needed now? | Astra, Fable | Testable is enough for stage 1; a measured improvement is the graduation test (B6) |
| 5 | Required confinement that can't be applied: refuse to run, or run unrestricted with the gap recorded? | Astra | Refuse to run (today's `confined-tools-unavailable` behaviour) |
| 6 | Are Gemini, pi and Grok in scope? | Fable | Declarations and fallbacks only, until they are installed |
| 7 | Discovery home: the Ecosystem pipeline or the evolution queue? Both have a path that can start work by itself | Fable, Astra | Decide in the discovery spec; an owner-charter lock on every start path is required either way |
| 8 | The first slice: the launch record plus per-job effort, the substrate first, or confinement first? | Astra, Fable | The launch record plus per-job effort |

## Constitution checks recorded for step 1

Both books' hashes are in `research-packet.md`.

| Rule | Disposition |
|---|---|
| 2.0 Rule 27 (dispatch withholds the answer) | Met procedurally: a question-only packet with the ranking withheld. The isolation itself relied on willpower (see the post-review) |
| 30 (no engine special-casing outside the adapter) | Violated today in about 356 places; the ratchet is proposed; the location question goes to Justin (#3) |
| 116 (simplest robust route) | No new subsystem; the existing `thinkingMode` pattern is reused |
| 118 / 122 (one provider is enough; no purchased service) | Every item has a same-provider fallback; credit-billed advisors and the billed commands are excluded |
| 26 / 39 / 56 (evidence, measured benefit, freshness) | The evidence class is recorded for each feature; no benefit is measured yet; a launch record is required first |
| 55 / 61 (no unbounded loops; capacity) | The advisor has no cap, so it is limited to the dev agent with a usage bound |
| 59 (stall coverage) | Never-prompt and the classifier modes need stall-table rows before they ship |
| 47 (compaction parity) | The prompt snapshot is left untouched until the compaction canary is checked |
| 44 (migration parity) | Each item that touches installed files carries its own migration |
| 82 / 98 (agent proposes, operator approves) | Discovery needs an owner-charter lock (#7) |
| 113 / 123 (multi-machine and team posture) | Engine features are agent-wide settings owned by the owner; per-run records are tied to the machine that ran them |
| 49 (traceability) | This table, plus the receipts |

## The B1 inventory

The full feature inventories are the Q2 tables in `step1/phaseA-fable-5-2.md`, `step1/phaseA-gpt-6-astra.md` and `step1/phaseA-echo.md`, corrected by the Phase B files. B1 asks Justin to approve this synthesis together with those tables.
