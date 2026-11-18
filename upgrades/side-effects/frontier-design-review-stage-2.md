# Side-Effects Review — Frontier design and review, stage 2: the recording driver run, the review ledger and `/design-review`

**Version / slug:** `frontier-design-review-stage-2`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (the reviewer module, an outbound-to-provider path and a new state store are touched)`

## Summary of the change

Build stage 2 of `docs/specs/frontier-design-review-standard.md` (approved 2026-11-17, topic 144319, message 144458). Tier 2. Builds on stage 1 (PR #3333).

- **Driver recording mode.** `cross-model-review.mjs --all [--record]`. `--record` only with `--all`; `--all` refuses `--family`. The run scans the design text with the outbound credential guard first; a live secret stops it before anything is sent and nothing is recorded. It then attempts every family the reviewer module knows in parallel (`src/core/designReviewRun.ts`): the Claude pass asks for the design model whatever the reviewer-model override says and falls back once to the door's default model on a refusal (decision 12); an outside family runs only if its CLI is one of the agent's `enabledFrameworks` (decision 10), else its row is `unavailable/disabled`. It never records the framework-activation baseline. The report goes to `POST /design/review/runs` with the session's token (secret-get, then a plain config token, only when the variable is unset; an empty variable fails loudly). Connection failure or 5xx spools the report; the next run and the next server start take spooled reports in.
- **Reviewer module.** The Claude hardening preflight gains a third answer, `inconclusive` (the probe itself failed), which still never runs the call and is not cached; `classifyReviewFailure` recognises a provider refusing the requested model (`model-not-on-plan`). Existing callers keep `claudeSupportsReviewerHardening()` (boolean) unchanged in meaning for `supported`.
- **Records.** `src/core/designReviewRecord.ts`: the design fingerprint (whole text, line endings normalised, only the post-review frontmatter keys left out), the record reference, report and peer-row validation over closed lists, the append that guards a torn last line, the derived status, the write record and the provenance line. `designReviewLedger.ts` gains the write entries.
- **Routes.** `src/server/designReviewRoutes.ts`: `POST /design/review/runs`, `GET /design/review?path=`, `GET /design/review/runs?since=` (this machine's rows for peers). The server is the only writer; it accepts a path only inside the project, the agent home or the reporting session's own working folder (from its record), never in the state folder; it re-reads and hashes the file itself and refuses `document-changed-during-review`; a run id is recorded once. Writes to the file are read from stored hook events (Write/Edit only) with the model from the token ledger's rows either side (new read-only `TokenLedger.modelsAround`). `GET /design/lane` (in `routes.ts`) tells `/design-review` whether a design session started now would get the design model, and the session's own state; `reviewHandoff` is now recorded on the session.
- **`/design-review` skill**, a bundled dev skill installed on every agent, over spec-converge's driver and templates.
- **Registration.** Capability index (`/design`), discoverability test, state registry (ledger class C, spool size-bounded), backup include list (ledger only).

## Decision-point inventory

- **Which files a run may be recorded for** — add: invariant over three roots minus the state folder.
- **A live secret stops the run** — add: invariant (irreversible-consequence), reusing the existing guard.
- **A record only from the all-reviewer mode** — add: driver argument invariant.
- **The same-door fallback once** — add: invariant.
- **Status derivation (reviewed / no-reviewer-reachable / not-reviewed)** — add: pure function over rows. No blocking authority in this stage; B26 (stage 3) is the consumer.

## 1. Over-block

Nothing that worked before is refused. `--all`/`--record` are new flags; existing `/spec-converge` calls (`--family`, `--detect-only`, `--hash-only`) are unchanged. The path limit refuses review of files outside the three roots; the refusal names the next step (copy the plan into the project). A memory-private session cannot record, by the existing default-deny guard, as it cannot run the constitution check today.

## 2. Under-block

- `modelBasis` is `requested` for every family in this version: no CLI output naming the model is read. The spec lists Claude as `reported`; the module checks the concrete model before every call, and the record says honestly which basis it has. Reading Claude's usage output for the model is a separate change to the provider.
- A write's model is known only once the token ledger has read that session's transcript; a run made before then records the write with no model, and a later run fills it in (merged on read). Seen in the live proof.
- A write by a shell command or a copy has no hook event; the line says "No record of which model wrote this".
- The plan-refusal recognition is by the providers' refusal wording; a new wording reads as `call-failed` (transient, so the next run retries) until the pattern learns it.
- A reason the module emits that the mapping does not know is recorded as `call-failed` and listed in the driver's output (`unmappedReasons`); passes reach the route already mapped, so the route itself has nothing unmapped to count.
- The spool's two readers (the server at start, the driver before a run) keep lines appended while they ran by cutting the file's new text at the old length; if the other writer rewrote the file in between, one line can come out torn, and the next intake drops and counts it. Rare.
- The no-follow open protects the file itself; a parent folder swapped between the check and the open is not covered (only the fingerprint and title could leak).
- A write made through a link whose name differs from the file's own is not found; the record only claims writes "on record".
- `X-Instar-Session-Id` names the reporting session; a caller naming another running session borrows that session's working folder as a root. The threat model accepts this for the agent's own sessions; finished sessions add no root.

## 3. Level-of-abstraction fit

The recording run is a new module over the existing reviewer registry and `runCrossModelReview` chokepoint (so the load-bearing-context refusal still applies to every pass); the driver stays a thin file-I/O wrapper. The server owns validation, hashing and the append, so a caller can only report, never assert.

## 4. Signal vs authority compliance

Required reference: `docs/signal-vs-authority.md`. Rows are signals. Nothing in this stage holds or blocks a message; the hold is stage 3's B26 judge, which consumes these rows as code-computed evidence.

## 4b. Judgment-point check

No new judgment point; the stopping judgment of the loop is the reviewing session's, as in `/spec-converge`.

## 5. Interactions

- `/spec-converge` keeps its own per-family calls and baseline; its SKILL wording migration to the driver command is stage 4.
- The feedback executor's code reviews call the reviewer module without recording mode and record nothing.
- Stage 1's plan evidence now has a writer: the live proof shows a real review flipping `GET /design/lane` from `not-confirmed` to `wouldRoute: true` and the next design spawn launching on Fable 5.2.
- The hardening preflight change keeps the boolean wrapper's meaning for callers that only ask "supported?".
- `classifyReviewFailure` now returns `model-not-on-plan` where it returned `error` for a provider refusing the requested model. Existing `/spec-converge` and feedback-executor callers see the new reason string; nothing in them branches on it (the independent-review judge reads status, verdict and model only).

## 6. External surfaces

- New routes under `/design` (Bearer-authenticated). The design text goes only to providers the agent already works through. A new bundled skill appears in every agent's skills folder on update (install-if-missing).

## 6b. Operator-surface quality

Not applicable: no dashboard or approval page.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Ledger: proxied-on-read.** Each machine appends rows its own server received (stamped with the mesh id, `local` alone) and serves them at `GET /design/review/runs?since=`; peers' rows are cleaned with `cleanPeerRun` (closed lists, clamps, known models). The merged read is stage 3's evidence step.
- **Write records** are resolved on the machine holding the hook events and token ledger and travel in the rows. **Re-reading a file** happens only on the machine whose row it is.
- **Spool: machine-local by design** — machine-local-justification: transient delivery buffer for this machine's own server; not backed up.
- **Status surfaces:** `GET /design/review`, `GET /design/lane`, listed in the capability index.

## 8. Rollback cost

Removing the routes and the driver mode leaves an inert ledger file. A full revert must ship with stage 4's reverse wording migration only if stage 4 has shipped; stage 2 alone migrates nothing.

## Conclusion

Stage 2 lands the record-making loop end to end, proven live with real Claude Fable 5.2 and GPT-6 Astra reviews on a throwaway agent, and closes stage 1's plan-evidence loop. Stages 3 and 4 follow.

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (Claude Opus 5.5), read-only over the diff and the spec

**Independent read of the artifact: concur** after its round-1 concerns were fixed as listed:

1. (low-medium) The server's spool intake dropped a report on a 5xx (an unreadable ledger) or a thrown append. Fixed: only a 4xx refusal drops; a fault keeps the line for the next start; lines appended during intake are kept. Integration case added.
2. (low) A design written and reviewed only on Codex did not say "No model from another provider reviewed this". Fixed (the line tests `outsideFamilyTookPart` alone); unit case added.
3. (low) The path check answered 404/400/413 before the root check, so any token holder could probe which files exist; and a link swapped between resolve and read was followed. Fixed: roots first with one 403 for everything outside them; the resolved path is opened once with `O_NOFOLLOW`, checked and read through that handle. Integration cases added (outside paths, a folder, `/etc/hosts`, a link pointing out).
4. (low) The write lookup resolved every stored write's path. Fixed: only a write to a file of the same name is resolved.

Minor notes taken: peer-row cleaning now requires a string path, a parseable write time and the family's own door; an enabled reviewer that is not installed is now named in the line; the driver's spool drain keeps reports appended while it ran; the reason-string change and the unmapped-reason accounting are recorded above.

## Evidence pointers

- Unit: `tests/unit/designReviewRecord.test.ts` (15, including both of the spec's example lines rendered exactly), `tests/unit/designReviewRun.test.ts` (12), and the touched reviewer, backup, capability, ledger and registry suites: 495/495.
- Integration: `tests/integration/design-review-routes.test.ts` (12).
- E2E: `tests/e2e/design-review-routes-lifecycle.test.ts`.
- Live proof on a throwaway agent (2026-11-17, M5, branch build, real reviewers): `--all --record` on a real plan: Claude Fable 5.2 found minor issues, GPT-6 Astra found no issues, Gemini `disabled` (not installed, not enabled), line "No record of which model wrote this. Reviewed 1 time. On this version: GPT-6 Astra found no issues, Claude Fable 5.2 found minor issues. (Review record 52d45c77871b)"; `/design/lane` flipped to `wouldRoute: true`; a live secret refused before any call with nothing recorded; an edited file read `not-reviewed`; with the server down the report spooled and the restarted server took it in ("1 recorded, 0 dropped"); with Codex removed from the agent's frameworks the line opened "No model from another provider reviewed this (none enabled for this agent)"; a session started on Opus 5.5 running `/design-review` handed the review to one design session, which launched on Claude Fable 5.2 (`design-lane`, `reviewHandoff`), ran the round in place, recorded under its own session id and revised the plan; the next run recorded that session's write ("no model on record" until the token ledger reads its transcript).

## Class-Closure Declaration (display-only mirror)

- **unbounded-self-action — closure: n/a.** One-shot user-driven action, not a self-triggered loop: spooled review reports are re-delivered exactly once per server start and once per driver run a session starts; a refused report is dropped, never retried. The machine-readable declaration is in this commit's trace.
