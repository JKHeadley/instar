# Side effects: imported history text reaches the agent only quoted (SEC-111)

Tier 1. Size: 3 source files (route, zip reader, awareness note), 1 new unit test file, 2 integration assertion blocks; about 120 lines. Effort: one build pass, two independent review rounds.

## What changes for running agents
- Agent (Bearer) reads of the imported-history routes change shape. Chat lists, a chat's summary, search results, the project list and the preview no longer carry export-written text as plain fields. Each item carries a `quoted` string in the existing `<imported-history>` wrapper instead, and list responses carry the existing `note`.
- Projects: the agent sees `ref`, `from`, `fileCount` and `quoted` (name, instructions, file names). Preview: counts and Instar's own `summary` stay plain; remembered facts become `{flag, ticked, quoted}` and project file names one quoted block.
- A ref built from an export id that is not the plain shape the routes accept is withheld from the agent (`null`). The agent could not open such a ref anyway.
- A refusal to read a zip can name a file inside it. The agent now gets the reason without the name; the owner still gets the name.
- The wrapper's closing-tag escape also catches spaced variants (`< /imported-history`).
- Owner (operator session) responses are unchanged. No stored data or config changes. Nothing replicates.

## Signal vs authority
No decision point is added. The wrapper is a presentation boundary for untrusted text; it does not grant or refuse anything.

## Rollback
Revert the commit. No data migration either way.

## Not covered here
The wrapper marks text as quoted; a model can still be persuaded by quoted text. That is the existing design of the import feature (spec §B.4), not changed here. Callers that read the old plain `title` field as the agent: none in the repository (the app uses the owner session).

## Second-pass review
**Reviewer:** independent read-only review subagent (fresh context). Round 1 objected: zip refusal messages returned an entry name from the export to the agent unwrapped. Fixed (name slot in `ZipRefused`, agent gets `withoutName`), plus the spaced closing-tag escape and a comment pinning `summary` as our own text. Round 2 concurred; its one nit (a `$` in a name could garble the owner's message) is fixed with a replacer function. Not blocking and kept: refs built from export ids reach the agent when they match the routes' plain charset `[A-Za-z0-9_.:-]`.
