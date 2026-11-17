# Side-Effects Review — Codex moves to GPT-6.2 Sol and Astra

**Version / slug:** `codex-gpt-6-2-default`
**Date:** `2026-11-17`
**Author:** Echo
**Second-pass reviewer:** independent review subagent

## Summary of the change

Operator directive (Justin, topic 144201, 2026-11-17): move all Codex usage to the newly released gpt-6.2-astra and gpt-6.2-sol. Both ids join `KNOWN_CODEX_MODEL_IDS`. The codex tier map moves `balanced` to gpt-6.2-sol and `capable` to gpt-6.2-astra in both resolvers (the adapter map in `openai-codex/models.ts` and the session-launch map in `frameworkSessionLaunch.ts`); `fast` stays gpt-6-luna because no gpt-6.2-luna exists. `CODEX_CHATGPT_FALLBACK_MODEL` is unchanged (gpt-5.6-sol). The Echo Bugs issues-group default moves from gpt-6.1-sol to gpt-6.2-sol.

Older-CLI safety generalizes the existing gpt-6.1-sol pattern. `codexCapabilities.ts` now reads `codex --version` once per binary per 60 s and exposes `CODEX_OLDER_CLI_FALLBACKS` (gpt-6.1-sol and gpt-6.2-sol to gpt-6-sol, gpt-6.2-astra to gpt-6-astra) plus `codexModelForCli`. The minimum CLI is 0.166.0, found by live subscription probes on 2026-11-17: 0.165.0, 0.160.0 and 0.156.1 refuse both new ids ("not supported when using Codex with a ChatGPT account"); 0.166.0, 0.168.0 and 0.169.0 answer both. Session launches (`SessionManager.resolveCodexLaunchModel`, `TopicProfileResolver`) fall back when the CLI is older or its version is unreadable. One-shot calls (`CodexCliIntelligenceProvider.evaluate` and the three openai-codex transports) fall back only on a positively older CLI, because they already retry a refused model on the floor; a strict model pin is never swapped.

The two review checks that require a specific codex model now accept the GPT-6.2 id of the same size: `judgeRoutedFeedbackReview` (astra lead: gpt-6.2-astra or gpt-6-astra; opus lead: gpt-6.2-sol or gpt-6-sol) and `FeedbackTriageArbiter.checkAuthority` (gpt-6.2-astra or gpt-6-astra). `crossModelReviewer` now resolves its codex model through the same older-CLI check (positively older CLI only), runs the strictly pinned call on that concrete id rather than the tier word, and its canary accepts the same-size pair. `FeedbackReadinessArbiter` now runs a codex authority on the exact approved id with a strict pin (it used to ask for the `capable` tier and match by substring, which would have failed every readiness call against an authority approved for gpt-6-astra the moment the tier moved). The model registry manifest records both ids, moves the frontier flag from gpt-6-astra to gpt-6.2-astra, and notes the older-CLI role of the GPT-6 rows.

The version probe never blocks the event loop on the async paths (sessions, one-shot calls, the cross-model reviewer): it spawns `codex --version` with stdin closed, force-kills it after 2 s, and settles on its own deadline even if the child never exits, so a wedged or SIGTERM-ignoring binary cannot hang a caller. Concurrent callers share one probe, registered before it can settle and never rejecting. A readable version is cached 10 minutes per binary, an unreadable one 60 s. The authority proposals only read the cache; the server warms it at boot and the proposal routes await it, so the first proposal names the right model. The topic resolver, the one sync caller that needs an answer, serves a stale entry while a background probe refreshes it, so only a binary's very first sync read can block (2 s, SIGKILL).

Tier 1 (a revert fully undoes it; no state is written). Size: about 25 files, roughly 500 lines including tests. Effort: one design pass, live CLI probes on six versions, one independent review round that found one blocking issue (readiness), fixed before commit.

## Decision-point inventory

- Codex tier resolution (`resolveCliModelFlag`, `resolveModelForFramework`): modified, new target ids.
- `SessionManager.resolveCodexLaunchModel`: modified; it now resolves the tier or unset model to the concrete launch id before the older-CLI check, and skips local-provider launches.
- `TopicProfileResolver` model arm: modified; the 6.1-only fallback becomes a table lookup.
- `CodexCliIntelligenceProvider.evaluate` and the openai-codex transports: modified; positively-older CLI swap before the call.
- `judgeRoutedFeedbackReview` and `FeedbackTriageArbiter.checkAuthority`: modified; the accepted id sets widen by the same-size GPT-6.2 id only.
- `crossModelReviewer` model canary and reviewer call: modified; concrete-id strict pin, older-CLI aware.
- `FeedbackReadinessArbiter` model request: modified for codex authorities only (exact approved id, strict pin); other providers keep the tier request and the substring family match.
- `KNOWN_CODEX_MODEL_IDS` closed enum: two ids added; every validator reading it (pins, spawn route, escalation, swap) now accepts them.

## 1. Over-block

No new refusal. The review checks accept strictly more (one id per size). A topic pin to gpt-6.2-x that was refused `off-enum` before now validates.

## 2. Under-block

A CLI at or above 0.166.0 could still be refused by the server for a given account; the probe covered all five Codex accounts, and the existing retirement self-heal (one-shot) and session start handling remain the recovery path. An unreadable version on a one-shot call keeps the new id; on an old CLI that costs one refused call before the floor retry. Sessions launched through a builder directly, without `SessionManager`, get no version check; all production spawns go through `SessionManager`.

## 3. Level-of-abstraction fit

The tier map stays the single source of the size-to-model choice. CLI capability is a local fact consumed at the launch boundary (SessionManager / resolver / provider), the same layer that already held the gpt-6.1-sol check. The fallback table lives next to the version probe so one edit covers every launcher.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. The version check is a bounded compatibility fact for an enumerated set of model ids; it never blocks, it only picks the known-working model. The review checks keep their authority and their shape: they still pin the size (an astra lead never passes on a sol review) and the triage call is still pinned to the exact id in the approved authority record via `strictModelPin` and the resolved-model comparison.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point added. The fallback is an ordered, deterministic floor.

## 5. Interactions

The rate-limit model swap runs before the older-CLI check, so a swapped-in id is also checked. A local-provider (ollama/lmstudio) launch is excluded explicitly so an unset model is never turned into a cloud id. A strict pin (`crossModelReviewer`, triage) is not swapped in the provider, so the reported model matches the launched one; on an old CLI that reviewer degrades honestly instead of reporting a model it did not use. The existing triage and readiness authorities (approved for gpt-6-astra) keep working, because both calls now run on the approved id; the authority proposal will now offer gpt-6.2-astra, which surfaces a "replace" approval for the operator rather than silently re-binding. The routing price manifest gains list-price rows for both ids (gpt-6.2-sol $2 / $10 / $0.10 cached, gpt-6.2-astra $8 / $40 / $0.40 cached per million tokens, read from the OpenRouter models API on release day; the same API reproduces the manifest's existing GPT-6 rows exactly), so spend on the new defaults is valued from the first call rather than shown as unknown. The Stage-B certified-set manifest gains one exclusion: `codexCapabilities.ts` is now reachable from the certified Codex delivery code through the already-excluded Codex provider; it holds model selection only, and the certified hashes and signed canary evidence are unchanged (`stage-b-certified-fingerprint.mjs --check` passes). A topic that was on gpt-6-sol by default moves to gpt-6.2-sol at its next session start; running sessions are unaffected.

## 6. External surfaces

Every Codex agent on the fleet launches the new models for balanced/capable work after update. The dashboard and topic pins can now select both ids. No chat note on a fallback (recorded instead, see 6a).

## 6a. Constitution check

First run 2026-11-17 22:31 UTC (100 standards) flagged three possible issues; a second run at 22:33 UTC flagged two. All are handled in this PR:

- **No Deferrals** (price rows missing): fixed; list-price rows for both ids are in the routing price manifest and the model registry.
- **Observability** (how much of the fleet runs the new models): already visible. Every one-shot call reports the model it actually launched through `onModel` into the per-feature LLM metrics, every session records its launch model, a session fallback logs one warning line naming the requested and used model, and a topic fallback carries `modelSource: older-codex-cli-fallback` plus an audit event `older-codex-cli` with `cannot-run:<id>`.
- **Near-Silent Notifications** (fallback note in the chat): fixed. The topic resolver no longer pushes a chat note for an older-CLI fallback (this also retires the gpt-6.1-era note); the fallback is recorded in the resolved source and the audit instead, since nothing needs the person to act.
- **No Manual Work** (a proposal on an old-CLI machine offering an id it cannot run): fixed. The readiness and triage authority proposals now read this machine's Codex binary, so on a CLI known to be below 0.166.0 they propose gpt-6-astra, which that machine runs.

A third run at 22:46 UTC flagged one more: **The User Experience Is the Product** (a synchronous 3 s probe could stall the server each minute on a machine where the version is unreadable). Fixed: the probe is non-blocking on every async path, has a hard 2 s deadline with SIGKILL, and caches an unreadable result for 10 minutes (see Summary). Writing the test for it exposed a real hang: a binary that reads stdin and ignores SIGTERM kept the first async version waiting forever; the deadline now settles it, with a regression test. A fourth run at 22:52 UTC returned no findings.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard file changes. No new operator-facing wording or layout; the previous older-CLI chat note is removed in favour of the session record and audit. The dashboard approval cards (classic page and console) now send the model they displayed (`shownModelFamily`) with an approval; the server binds exactly that model and, if its proposal changed since it was shown, refuses with "authority proposal changed since it was shown: it now names <model>, not <model>; review it again", which the existing result note shows in place. The operator re-opens the card and approves the current proposal: one tap, no command.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: the CLI version is per machine, so each machine probes its own binary and picks its own launch model. The tier map ships in the build, identical on every updated machine. A machine still on the previous build launches GPT-6 models; the review checks accept the GPT-6 ids so a review recorded there still counts. No durable state is written, so nothing strands on topic transfer.

## 8. Rollback cost

Revert the commit and release. No config, profile or ledger migration. Agents whose operator set `sessions.frameworkDefaultModels['codex-cli']` to a GPT-6.2 id after this release would see it refused by an older build's enum and fall through to the tier default, which is the existing behavior for any unknown id.

Migration parity: no `PostUpdateMigrator` step. Instar has never written `frameworkDefaultModels['codex-cli']` (init, setup and migrations leave it unset), so any value present is a hand choice and must not be overwritten. Agents with it unset pick up the new tier default on update with no migration.

## Conclusion

Contained, reversible, and the older-CLI path is covered by version-boundary tests. Ships.

## Second-pass review (if required)

**Reviewer:** independent general-purpose review subagent (Claude Opus 5.5), two passes, final verdict: concur.

Required (session launch and review checks). An independent reviewer subagent read the diff and this artifact and raised three concerns:

1. Blocking: `FeedbackReadinessArbiter` asked for the `capable` tier and matched the approved family by substring, so an authority approved for gpt-6-astra would refuse every answer from gpt-6.2-astra and stall the readiness stage until re-approval. Fixed: a codex authority now runs on its exact approved id with a strict pin; tests cover both approved ids and a wrong-model refusal.
2. The feedback cross-model review was strictly pinned to the 6.2 ids, so it would always degrade on a CLI below 0.166.0. Fixed: the reviewer takes the older-CLI model on a positively older CLI, runs the call on that concrete id, and the canary accepts the same-size pair; tests cover both overrides on CLI 0.165.0.
3. Test gap for a local-provider launch on an old CLI. Added: such a launch carries no cloud model id.

Third review pass (after the constitution-check fixes) found one bug and two minor points, all fixed with tests: (1) a probe whose spawn threw synchronously hit a ReferenceError in its own cleanup, left a rejected promise cached in the in-flight map and failed the launch; the probe now registers before spawning, deletes only its own entry and never rejects (NUL-byte path test). (2) an unreadable version is cached 60 s, not 10 minutes, so one slow cold start cannot pin a current CLI to the older models. (3) the first proposal after boot read an empty cache; the cache is warmed at boot and awaited by the proposal routes.

A fourth pass found one more: the approve (POST) handlers rebuilt the proposal from a cache that could have expired since the card was shown, binding a model the operator never saw. Fixed: both handlers warm the version cache first, the dashboard sends the model it displayed, and the server refuses an approval whose shown model differs (route test).

The reviewer confirmed every codex launch path applies the fallback, local-provider launches are excluded, recorded and launched models match, the widened checks only accept same-size ids, and no stale ids remain in `src/`. All three concerns were addressed in code with tests. On recheck the reviewer concurred (targeted tests: 7 files, 157 passed) and added one non-blocking note: a new readiness or triage authority proposal made on a machine whose CLI is below 0.166.0 still offers gpt-6.2-astra. Because those calls are strictly pinned, approving it there would fail honestly rather than pass falsely. Resolved after the constitution check: the proposals now read the local Codex version and offer gpt-6-astra on such a machine.

## Evidence pointers

- Live probes 2026-11-17 (this machine, ChatGPT account): 0.169.0, 0.168.0, 0.166.0 answered OK for both ids; 0.165.0, 0.160.0, 0.156.1 refused both. Mama PC probe the same day: all five accounts listed both ids and answered on CLI 0.169.0.
- Unit tests: codexCapabilities (version boundary, fallback table, both policies), echo-bugs-profile-default (each fallback pair), session-manager-behavioral (each tier on a current and an older CLI, unreadable version), codex-model-tier-resolution, feedback review and triage checks.

## Class-Closure Declaration (display-only mirror)

A Codex CLI below 0.166.0 runs the previous GPT-6 model of the same size instead of failing; no dead session is expected from this model/CLI mismatch.

Self-action declaration (unbounded-self-action, closure n/a): not a self-triggered loop. The only new spawn is the `codex --version` probe, at most one per binary per cache window (10 minutes readable, 60 s unreadable), shared by concurrent callers, with a hard 2 s deadline; it never retries or re-drives itself.
