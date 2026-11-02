# Side-Effects Review — Ecosystem idea pipeline

**Version / slug:** `ecosystem-idea-pipeline`
**Date:** `2026-11-01`
**Author:** `echo`
**Second-pass reviewer:** `codex-cli:gpt-6-astra (concurred, round 5)`

## Summary of the change

Builds the approved spec `docs/specs/ecosystem-idea-pipeline.md`: a dev-gated server service in
`src/ecosystem/`, routes, an Ideas console page, a replicated ledger, framework admission probes, and
the adoption lint. Tier 2 (new capability; a spec was converged and approved). Proportion: spec 3 review
rounds; about 2,700 source and 1,500 test lines.

**Decision points touched:** as tabled in the spec's "Decision points touched". New: framework admission (invariant). None gates a running agent.

## Deviations from the spec

- **Provider change.** The spec allowed a stronger call form if cheap. `noLocalTools` (Codex) and `reviewerHardening.noTools` (Claude) were added, because a live probe showed Codex's read-only sandbox reads local files. Both default off, so no other caller changes.
- **Ledger order.** Events carry a Lamport `seq`, added in build: timestamps alone misordered same-millisecond events.
- **Decision-quality meter.** The census row is `pending:backlog:decision-quality-enrolment`, pinned in the ratchet, as triage's second opinion is. The monthly audit counts overturned verdicts on the page and the ledger, but those verdicts do not reach `/decision-quality` yet. The spec said this "also feeds" the meter, so that part is not done.
- **Bench coverage.** `pending: wave-3`, pinned in the ratchet.
- **Search index.** Capped at 2,500 chunks across roots, specs and standards first. Past the cap, word search still covers specs and code. A first build on this machine took about 8 minutes of one core, and it rebuilds when a root moves, so about weekly.
- **Launch recovery.** An attempt is recorded before the session starts; one that left no session running is shown, not started again, and only the operator can retry it. That is stricter than the spec's recovery wording, because a finished session looks the same as one that never ran.
- **`later` decisions** are recorded but nothing brings them back on a date; they stay on the page in their band.
- **Exception file.** The PIN route records the decision and audit reference; the agent commits `docs/proofs/<idea>.json` by hand, as the spec says.

## 1. Over-block

The lint fails only a change to a listed flag's default on a spec that carries `ecosystem-idea`. No such spec exists yet. Its parent-and-leaf text match can trigger on a neighbouring key under the same parent in a 40-line hunk; the remedy is a report or an edit to the spec's flag list.

A framework that fails a probe is refused, including through a transient failure. It runs again only on a CLI version change, so a transient refusal sticks until then; deleting `state/ecosystem/admission.json` re-probes. Accepted: refusing is the safe direction, and the status route says why.

## 2. Under-block

Named in the spec and restated: a passed probe is evidence about one attempt. A model able to read a file could decline during probes. The lint does not see an untagged PR, a change with no flag, or an operator's own enable, and the agent writes the frontmatter. A poisoned claim can mislead a verdict; verdicts decide nothing alone.

## 3. Level-of-abstraction fit

A service rather than a job session, because a job session carries the auth token and cannot confine paths. It follows `src/feedback-factory/triage` (packets, closed schema, owner fence, PIN plan and commit) without sharing its store, which belongs to the drain.

## 4. Signal vs authority compliance

Required reference: `docs/signal-vs-authority.md`. Advice only at runtime. The lint is a deterministic process gate on a development step with an override (the recorded exception); it asks whether a record exists and is well formed, never whether a change is good. Framework admission is a must-fail probe on evidence, and refusing only reduces what the feature does.

## 5. Interactions

The shared `state/semantic.db` is untouched: this has its own index. `RenderedPlanStore`'s type gains `ecosystem-*`; the commit route is the only reader of those plans, and each route family has its own store instance. The one agent-started session goes through `spawnSession` and is counted like any session. Feedback triage shares the provider and may share the file-read exposure; that is `fb-114956d3-956`.

## 6. External surfaces

Reads public GitHub repos on a weekly tick, on the lease holder, on agents where it is enabled. Spends model tokens within limits: 300k per project, 600k per run, paused at 75% quota. It raises at most three keyed attention items. Sends no message to any other project.

## 6b. Operator-surface quality

The Ideas page leads with one sentence saying whether anything is ready, then the ideas by band, each with its plain reason and Start a spec, Decline and Later. Raw internals (commits, hashes, model output fields) are not primary content; a goal review is one labelled line. Decline sits beside Start without emphasis and asks for the PIN, showing the server's own wording first, and it is reversible by new evidence. Plain language at phone width, using the console's existing cards. Not yet looked at on a real phone: the page was tested by its model and imports only, so this needs a look on the dev console before merge.

## 7. Multi-machine posture

`unified`. Ledger events replicate as the `ecosystemIdeas` store with a new journal kind, injected whenever the feature is on. Reviews, decisions and notices run on the lease holder, epoch-fenced; a non-holder answers 409 naming it. The search index, source mirrors and clones are derived or disposable. `admission.json` and `notices.json` are per machine: a new holder re-probes and may repeat a notice once, keyed by condition.

## 8. Rollback cost

`ecosystemIdeas.enabled: false` and a restart stop the tick and routes; the ledger stays. A code revert removes the feature and the lint. A peer on older code does not advertise the store, so it is sent nothing.

## Second-pass review

Independent reviewer: Codex (`gpt-6-astra`), through the spec-converge reviewer door, reading the code. Five rounds. The first three raised, and this change fixed: stale writes from a lost lease; new revisions inheriting judgments; PIN approval not binding the displayed revision; launch recovery able to start twice; incomplete payload validation; empty paths passing the lint; unfinished ideas bypassing failure backoff; automatic launches going stale across awaits; partial scans given a full week. Round 4 raised two consequences of those fixes, also fixed. Round 5 concurred on those two changes, reading the service file only, by static inspection; its boundary note is that the ledger's part is shown by tests rather than that read.

The reviewer was a different model family and saw the code, not this author's conclusions. It was a cross-model script rather than a same-model subagent, so that the author's context could not lead it.

## Class-Closure Declaration

`unbounded-self-action`: closure `guard`, citing `tests/unit/self-action-convergence.test.ts` (ratchet). Retrying a failed project review is registered as `ecosystem-idea-review`: at most 3 attempts per cycle with backoff, a durable week, then a breaker after 3 cycles. Nine attempts in total, then silence until a person retries. The durable counters live in the replicated ledger, so a restart buys none back.

## Build steps

1. A no-tools call form for prompts holding outside text.
- feat(ecosystem): the idea pipeline service, ledger and routes
- feat(ecosystem): the adoption lint on tagged specs
