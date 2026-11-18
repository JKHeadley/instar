# Convergence Report — Meeting-transcript analysis as a built-in skill

## Cross-model review: codex-cli:gpt-6-astra

A GPT-family reviewer (codex CLI, model gpt-6-astra) ran in all six rounds. Gemini was unavailable on this machine every round (`gemini-not-authed`). The Anthropic clean-door read was not run.

## ELI10 Overview

Luna, the SageMind agent, built a careful way to turn a recorded client call into a complete record: what was decided, who does what, what the client still owes. It splits the work into layers, files every line of the transcript with its exact words, runs keyword searches, has two helpers read the call blind, ties every screenshot the operator took to the moment it was taken, and then has fresh checkers look for anything still missing. Small scripts refuse to pass when something is left unaccounted for. Justin asked, through Luna, for this to be part of Instar for every agent.

This spec ships it as a built-in skill plus its checking scripts. Everything that touches a real client (fetching the recording, preparing changes for the client's page, telling the operator) stays in each agent's own small add-on scripts. It starts on development agents and on Luna; it goes to every agent only after one real call where the operator finds nothing missing.

The main trade-off: the method is thorough and therefore costs model time (roughly half a million tokens for a two-hour call). The spec makes that cost visible, stops when quota is short, and always says honestly whether the read finished checking or was cut short.

## Original vs Converged

The first draft was a near-copy of Luna's package with an install plan. Review changed it in six big ways:

- **Nothing the agent writes is run as code.** The package built its ledger by importing an `.mjs` file the agent wrote from client text; now it is JSON, read as data.
- **The checks can't pass without checking, and can't be gamed cheaply.** A path bug let five scripts exit "pass" without running; exit codes now mean what they say; a single big row no longer covers every hit under it; every dismissal is shown to the operator; a new final check re-runs all checks on exactly what is committed.
- **The verifiers are asked a fair question.** They were told the read was incomplete (and never once came back clean); now they're asked what's missing, and "nothing" is allowed. Honest statuses (`converged`, `items-settled`, `settled-with-limits`, `INCOMPLETE`) come from the files, not from the agent's say-so.
- **Helper readers have no tools.** Transcript text can't make them do anything; the Codex and Claude settings match the ones Instar already uses for this, and pictures are attached properly.
- **Client data has a declared home.** Each client's material lives in that client's repository and remote, checked before anything is fetched and before every push, with a credential scan of exactly what is pushed; raw audio isn't kept.
- **One run per meeting, and a safe rollout.** A lock in the client repository stops two machines (or two sessions) running the same meeting; each run works in its own git worktree. It starts on development agents and Luna, and reaches every agent only after two real calls the operator reviews with nothing missing, plus a held-out test set annotated by a different model family.


## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, adversarial, integration, decision-completeness, lessons-aware, verify-state, codex (gpt-6-astra), constitution gate (7 flags) | ~25 distinct after de-duplication | 6 | full rewrite (see Original vs Converged) |
| 2 | security/adversarial (6), integration/decision (6), codex (10), gate (6 flags) | ~12 distinct | 8 | order of work with preflight/after-push; tool-less reader flags + image transport; receipts; status table; git meeting lock; capability matrix; graduation fail branch; honest limits |
| 3 | combined internal (2), codex (4), gate (5 flags) | 6 | 6 | lock acquisition/release; scan of exact staged snapshot; secret patterns copied; `settled-with-limits`; held-out fixtures |
| 4 | combined internal (4), codex (3), gate (3 flags) | 4 | 3 | notify before lock release; status precedence; annotator sees screenshots; full CLI argument/env parity |
| 5 | codex (1), gate (5 flags) | 1 + 3 gate items taken | 3 | per-run git worktrees; receipts carry model/outcome/tokens; agent-side takeover when holder confirmed stopped; one transient retry |
| 6 (cap) | codex (1), combined internal (2) | 3, all build-detail, applied at the cap without a further round | 4 | push reconciliation by rebase; local lock in git common dir; detached worktree pushing to the sync branch |

Round notes: Standards-Conformance Gate ran every round (7, 6, 5, 3, 5 flags; round 6 not re-run after the final edits). Internal reviewers on claude-opus-5-5 throughout (no tier drop). External codex-cli gpt-6-astra ran in all six rounds; gemini-cli unavailable all rounds (`gemini-not-authed`). From round 3 the six internal lenses ran in one combined reviewer per round instead of three, to keep cost in proportion as findings fell.

Round-by-round notes:
- Round 1. Standards-Conformance Gate: ran (7 flags). Internal reviewers on the authoring session's model (claude-opus-5-5), three subagents covering security+adversarial, integration+scalability, decision-completeness+lessons-aware+verify-state. External: codex-cli `gpt-6-astra` ran (14 findings, all DESIGN); gemini-cli unavailable (`gemini-not-authed`: no auth method set on this machine). Clean-door Anthropic family: not run.

## Proportion

Tier 2 (new fleet-capable built-in skill, client data, external pushes). Spec grew from ~100 to ~200 lines. Six rounds used, the Tier-2 cap. Design findings fell 25 → 12 → 6 → 4 → 1 → 3 (small). The size is in line with what ships (eleven helper scripts and a client-data boundary), but it is near the top of what a skill should cost to review.

## Left behind

Accepted limits (in the spec's Honest limits): the main agent reads client text with its ordinary tools (per-task sandboxing filed as fb-3cb0ba3e-b90); `verifyLive` is the hook's own observation; repository identity does not prove who can read the remote; receipts make fabrication visible, not impossible; credentials shown in screenshots are not caught by the text scan; a short window between the LOCK re-read and a hook's mutation.

Applied at the round-6 cap without a further review round: push reconciliation by rebase, the shared local-lock path, the detached-worktree push rule, the Claude sign-in key in the reader environment, the retry row.

Constitution-gate flags contested, with reasons:
- *Framework-Agnostic* (Gemini and other engines blocked): runs on a framework without a tool-less reader adapter are `blocked: no-fresh-reader` on purpose, rather than run with unisolated readers. The adapter table is extensible; Gemini was not signed in here to verify a tool-less mode. Adding an adapter is a follow-on for whoever brings that engine to the dev rung.
- *Judgment Within Floors* (two-round minimum): evidence is in the spec (Luna's runs rose again after falling, 4 then 5); the ceiling is an operator-set judgment.
- *Signal vs. Authority* (credential match holds the push): this is the same deterministic floor as Instar's live-credential wall on outbound messages, because a pushed credential cannot be taken back. The agent can clear a false match with a recorded reason.
- *Multi-Machine* (durability when peers are away): the declared remote is the durable copy and does not depend on any peer machine; every machine pulls it before a run.
- *Structure beats Willpower* (client isolation partly by instruction): partly structural (tool-less readers, location and sync checks, credential scan). The rest is the accepted limit above.

Precision items not worked into the spec: wording of the client-name scan test (it can only catch listed names); the token estimate per round is an estimate.

## Full Findings Catalog

### Round 2 (summary)

| # | Reviewer | Finding | Class | Resolution |
|---|---|---|---|---|
| 1 | security, integration, codex | Codex `-s read-only` still has a shell; Claude needs `--tools ""` | DESIGN | noLocalTools flag set and `--tools ""`; parity test; live injection fixture at test-agent rung |
| 2 | security, codex | Sync check after fetch; push check circular | DESIGN | `--preflight` before any write; commit → push exact commit → `--after-push` → notify |
| 3 | security, codex | Nothing ties a round file to a real reader | DESIGN | `fresh-read` receipts checked by `run-check`; residual named in Honest limits |
| 4 | security, codex, integration | Status rules contradicted each other; `items-settled` reclassification escape | DESIGN | One status table from the last round; downgrades listed |
| 5 | security, codex, integration | Pictures cannot reach a tool-less stdin reader | DESIGN | stream-json image blocks / `codex -i`; explicit downgrade without an image adapter |
| 6 | security, codex, integration | Ownership read unnamed; blocks single-machine agents; races | DESIGN | Git-pushed meeting LOCK (push refusal is the fence), re-read before each side effect, keyed side effects |
| 7 | integration | Nothing pulled | DESIGN | Preflight pull to remote head |
| 8 | integration | Graduation could not fail; one sample | DESIGN | Two consecutive clean meetings; reset on escape; fleet step dropped after three |
| 9 | codex | Final hashes don't prove checks ran on final files | DESIGN | `--final` re-runs every deterministic check itself |
| 10 | codex | Optional hooks vs mandatory checks | DESIGN | Capability-to-check matrix |
| 11 | codex | Mixed helper versions mid-run; rollback discoverability | DESIGN | Helpers copied into the run at preflight; preflight refuses when the gate is off |
| 12 | codex | No independent semantic test path | DESIGN | Held-out annotated fixtures through the real skill at the test-agent rung |
| 13 | integration (L11) | Push to client remote without secret scan | DESIGN | Durable-scrub credential patterns hold the push |
| 14 | codex | Main agent and hooks unrestricted; repo identity ≠ readers | DESIGN | Accepted in Honest limits with reasons (sandboxing the main session is a separate Instar change, filed) |

### Round 1

| # | Reviewer | Finding | Class | Resolution |
|---|---|---|---|---|
| 1 | security, codex | `build-ledger.mjs` imports the agent-written `.mjs` ledger source: executed, not read | DESIGN | Ledger source is JSON, `JSON.parse` + schema; nothing written by the agent is imported |
| 2 | integration (reproduced) | Five scripts' `import.meta.url === file://argv[1]` guard fails via symlink or spaced path: no output, exit 0 | DESIGN | `fileURLToPath` vs `realpathSync` guard; symlink and spaced-path tests |
| 3 | security, decision, integration | Exit codes claimed (0/1/64) are not the scripts' (usage 2, parse error 1, listing modes 0) | DESIGN (factually wrong) | Implemented as a change: 0/1/64, `REPORT ONLY` modes never used as gates |
| 4 | adversarial | One row per window settles every sweep hit and reader item; tiny quotes pass | DESIGN | Coverage must lie on the hit's own line or carry a written verdict |
| 5 | adversarial | Any word passes as a verdict / "because" | DESIGN | All dismissals listed in a "What was set aside" report section with counts (operator arbiter) |
| 6 | adversarial, codex | Verifier loop self-reported: labels, convergence, reversals, round count | DESIGN | `run-check.mjs` with a round-file schema; status derived from the files |
| 7 | adversarial | Blind-reader files can be stale or fabricated | DESIGN | Transcript sha256 + distinct reader ids checked by `run-check` |
| 8 | security, codex, gate | Readers/verifiers are injection paths into tool-holding subagents; safety by instruction | DESIGN | `fresh-read.mjs`: tool-less readers via the clean-door hardening |
| 9 | security, codex, integration | Client material leaves through git sync; GitSync only syncs stateDir; posture justification invalid | DESIGN | Declared `sync` repo+remote checked by `run-check`; push required; raw audio not kept; posture unified |
| 10 | codex, security, decision | `liveUnchanged` self-attested; "fails the run" had no script | DESIGN | Hook's `verifyLive` independent read; `run-check` blocks on anything but unchanged |
| 11 | lessons, gate | Verifiers told "the read is incomplete" (planted answer); package never rejected a finding nor had a clean round | DESIGN | Neutral question; empty list valid |
| 12 | decision, gate | 7-round cap unevidenced; stop rule possibly unreachable | DESIGN | Judgment within a floor: ≥2 rounds, continue while item-changing findings remain, spend ceiling named as a spend ceiling |
| 13 | decision | Both lists counted toward convergence, contradicting the cited lesson 4 | DESIGN | Only item-changing findings hold the loop (round 2 refined: `converged` vs `items-settled`) |
| 14 | decision, codex, gate | Reversal rule refused correct fixes | DESIGN | Quote-settled reversals applied; unsettled ones become disputes that hold dependent changes |
| 15 | lessons, codex, gate | Fleet in the same release; dev rung a named agent; graduation could not fail | DESIGN | Config gate (dev-agent default, Luna by flag); awareness entry with the fleet flip; graduation = fixtures with planted misses + operator-found escapes 0 |
| 16 | lessons, codex, integration | Full procedure only for Claude Code; referenced files had no installer | DESIGN | Single SKILL.md with appendices; canonical + Codex rendering; Codex-only init fixed; Gemini pointed at canonical file |
| 17 | integration | Luna's copy is `gci-post-call`, not the shipped slug | DESIGN (factually wrong) | Her skill keeps hooks, calls shipped scripts; change list sent on thread 1f805ef5 as a dev-agent-live step |
| 18 | codex | Preserved skill copies vs overwritten helpers | DESIGN | `helperVersion` checked by `run-check`; skill text changes by migration |
| 19 | codex | Multi-machine run ownership/idempotency | DESIGN | `runId` + machine id; `notifyOperator` keyed by `runId` (round 2: ownership read before side effects) |
| 20 | codex | Multi-recording ids collide | DESIGN | `recordingId` everywhere, namespaced ids |
| 21 | codex | Hook contract incomplete (count mismatch, `recorderNotes`, `drafts`) | DESIGN | One versioned contract, required vs optional, statuses |
| 22 | codex | Historical regression set demanded of unrelated meetings | DESIGN | Per-meeting regression set; history becomes fixture cases replayed by `eval.mjs` |
| 23 | codex | Circular step order, stale checks | DESIGN | One dependency order; `run-check` matches final file hashes |
| 24 | codex, decision | Structural checks presented as semantic proof | DESIGN | "What the checks prove, and what they don't" section |
| 25 | lessons | Read's own quotes unchecked (a misquote escaped 7 verifiers) | DESIGN | Read quotes go through the verbatim check |
| 26 | scalability | Model spend unestimated | DESIGN | Estimate stated; sequential rounds; stop on quota shedding |
| 27 | decision | `shows` 60-char minimum rejects correct short descriptions | DESIGN | Description or `nothing` with a reason; verifiers check the picture |
| — | gate: Structure beats Willpower (client isolation by instruction) | partly resolved structurally (fresh readers tool-less, folder location and sync target checked); the rest accepted, see Left behind | | |

## Convergence verdict

Converged at the round-6 cap (Tier 2). The last round found three build-detail design items, none about safety, security or data loss; they were applied to the spec and are disclosed above as not re-reviewed. Six accepted limits and five contested constitution flags are listed under Left behind. Spec is ready for Justin's review and approval; nothing is built before `approved: true`.
