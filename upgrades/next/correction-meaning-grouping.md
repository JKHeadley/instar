<!-- bump: patch -->

## What Changed

The correction analyzer now counts reworded repeats of the same preference
together. Before, it grouped two correction records only when about two thirds
of their words matched; people never repeat a preference word for word, so on
a live agent with 131 records it formed zero groups and never learned a
preference. Now, for same-kind records that share at least a few words, Jev
(TypeSafe) is asked whether they state the same core rule, and GPT-6 Luna
decides the pairs Jev is unsure about. A group still needs every pair inside it
to match, and the recurrence gate (4 occurrences, 2 days, 2 sessions) is
unchanged. Each pair is asked once and cached. New read route
`GET /corrections/groups` lists the current groups (summaries only, no model
calls); `POST /corrections/analyze` reports which grouping ran. Live on a
development agent, dark on the fleet (`monitoring.correctionLearning.meaningGrouping`).

## What to Tell Your User

Nothing changes for you by default on most agents. On a development agent, when
you correct me the same way in different words over several sessions, those
corrections now add up toward a saved preference instead of counting as
unrelated one-offs.

## Summary of New Capabilities

- Meaning-based grouping of correction records before the recurrence gate
  (Jev pair question, Luna referee for unsure pairs, complete-link, cached).
- `GET /corrections/groups`: see which correction records currently count together.

## Evidence

Measured on the live 131-record ledger (2026-10-29): word overlap formed 0
groups; meaning grouping asked 583 candidate pairs (46.9 s, 583 Jev + 22 Luna
calls, 0 failures) and formed 7 groups of 2-3 records, each read and confirmed
to be one preference (docs/measurements/2026-10-29-correction-meaning-grouping.md).
Unit, integration and e2e tests cover both sides of each decision.
