# Convergence Report: Job launch intent and launch record (per-job thinking mode)

**Reviewed artifact:** `docs/specs/job-launch-intent-record.md`, sha256 `35d932801fc87b13ad79c0755efa0b8f693f6e5e5aae335388b068b51d4be394`. The stamp is written on exactly this text: the only later change is the frontmatter lines the tag writer adds. Nothing else has been edited since the last full read, and the independent reader (GPT 6 Astra) confirmed the hash.

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-family read ran in every pass. The last four passes ran **read-only inside the instar worktree with source access**, so code claims were checked against the code. The Anthropic clean-door reader was `claude-code:claude-fable-5-2`. It is the same model family as the author, so it is disclosed separately and not counted as cross-model.

Internal Claude reviewers covered all six lenses in rounds 1 to 3. The Standards-Conformance Gate ran in rounds 1 to 3, raising 3, 2 and 1 flags. The round-3 flag ("ladder: not applicable") is a false positive, confirmed against `MaturationLadder.ts:313` and the coverage test.

## ELI10 overview

Instar's scheduled jobs all run at the AI engine's default "how hard to think" setting. This spec lets a job choose a neutral thinking level. Each engine's own launch code translates it: Claude Code's effort flag, or Codex's reasoning setting. Engines without such a setting skip it and say so.

Every job run records what the engine was actually told and which engine version ran. That record is the base that every later engine feature will use for honest before-and-after numbers. A small build check also stops new "is this Claude or Codex?" code from spreading outside each engine's own section.

**What is not in this spec:** the experiment that measures whether low effort saves usage without hurting quality. A source-aware read showed it needs its own design, so it was split into its own spec (initiative `job-thinking-mode-pilot`). This spec ships the mechanism and its record, proved mechanically.

## Original vs converged

- **CLI version.** It was read once per process, so it went stale after self-updates and could block a spawn. Now an async probe runs with an identity-keyed 1-hour cache. It falls back to the probe whenever the existing Claude retainer has no version, and patches the row afterwards. Neither the spawn nor the start record is ever delayed.
- **"Off".** It was undefined. On Claude it now uses the existing environment channel. On Codex it maps to low, and the remap is visible.
- **Posture.** The record was claimed to be "replicated". It is in fact machine-local, and the spec now says so; the gap is filed as fb-ca7635e0-b76.
- **Definition paths.** Only frontmatter carried the field at first. Now every path that persists or loads a job carries it, guarded by a round-trip test. Each read found one more hand-listed path. The paths deliberately left out are named, each with its reason.
- **Row size.** `launch` is shed last among the optional fields under the existing 2,048-byte cap.
- **Scope.** The benefit experiment (day-alternating arms, grade comparison) moved to the pilot spec.

## Iteration summary

| Pass | Spec hash | Reader(s) | DESIGN findings | Outcome |
|---|---|---|---|---|
| Round 1 | f8b3f90d… | 6 internal lenses, Astra, Fable, gate (3 flags) | 10 | Revised |
| Round 2 | f8579b95… | 2 combined internal, Astra, Fable, gate (2) | 7 | Revised. The tripwire fired (10 to 7). Echo overrode it alone, and the step-2 post-review judged the override unjustified |
| Round 3 | f6c73d7e… | 1 combined internal, Astra, Fable, gate (1) | 2 | Fixed and verified by a targeted check. A stamp written on unread text was **withdrawn** |
| Final read | 5d3df7cd… | Astra and Fable, **with source** | 5 | **Scope cut** (the interim path from the step-2 pre-review) |
| Cut read 1 | 78415d96… | Astra and Fable, with source | 2 (missed definition paths) | Revised |
| Cut read 2 | 5ab6a46e… | Astra and Fable, with source | Astra: 1 (template generator). Fable: CONVERGED | Revised (the generator is now scoped out, with its reason) |
| Cut read 3 | **35d93280…** | Astra, with source | 0 | **CONVERGED** |

## Proportion

⚠ The budget was 3 rounds and 4 hours. The review used 3 rounds plus 4 full reads, in about 2 hours 15 minutes. The spec is about 2,700 words, roughly 1.8 times its 1,500-word budget. It adds no new durable mechanism, but the length is a signal: most of the growth is code-verified detail that the first three rounds could not catch, because those reviewers had no source access. **Lesson, now applied:** from round 1 on, external reviewers get read-only source access.

## Left behind

These were not applied, so the reviewed hash stays the stamped hash.

- **Downgrades.** Older loaders accept unknown manifest keys and ignore them (Astra). "Fail closed" therefore holds only for the private transfer. A downgraded loader runs the job at default effort. The "remove before downgrade" instruction stands, and the wording gets corrected during the build.
- **`addJob` and CLI `job add`** (`commands/job.ts:15,45`, `cli.ts:1717`) cannot set the field and are deliberately not covered. The field is set afterwards in the authoritative definition.
- **`writeUserTemplate`** is left out because migrated user jobs read the field from the manifest, not from frontmatter. That reason gets stated in the text during the build.
- **The D8 job** (`bugs-overseer`) is confirmed on the lease holder as a user agentmd job on Opus, about 12 runs a day (Studio `GET /jobs`, 2026-11-11). The reviewers couldn't see it from the worktree.
- **The dashboard job editor's existing defect** is filed as fb-63490288-73d.

## Convergence verdict

**Converged after the scope cut.** The last full, source-aware, cross-family read of the exact stamped text found no DESIGN finding, and Fable's previous read reached the same verdict. No safety, security or data-loss finding is open. The spec is ready for Justin's review and `approved: true`.
