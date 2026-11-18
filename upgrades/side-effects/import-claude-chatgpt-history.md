# Side effects: bring Claude and ChatGPT history into Instar (slice 1)

Spec: `docs/specs/import-from-claude-chatgpt.md` (converged in four review rounds; approved under Justin's 2026-11-17 request in topic 143810).

## Change
- `src/import/safeZip.ts`: reads named entries from an export zip, with no dependency.
  - It walks the central directory and enforces the limits before inflating: 2 GB zip, zip64 refused, unsafe names, links and duplicate names refused, local header matching the directory, 100:1 ratio, 4 GB unpacked.
  - It streams each entry and stops if one unpacks past its declared size.
- `src/import/jsonArrayStream.ts`: reads a top-level JSON array one element at a time, with a 50 MB cap per element.
- `src/import/exportParsers.ts`: the Claude and ChatGPT conversation parsers (ChatGPT follows `current_node`) and the Claude project parser.
  - Secrets are removed through `durableSecretScrub` before splitting.
  - Long messages become 16,000-character parts keyed `<id>#<n>`. Beyond 10 parts, the full text is kept as an attachment.
- `src/import/ImportedHistoryStore.ts`: `<stateDir>/imported-history/`, with files at 0600.
  - Re-import is idempotent by id.
  - The list is ordered by each chat's own time.
  - Keyword search has a time budget.
  - There is no replication hook and no journal event.
- `src/import/proposedFacts.ts`: deterministic fact proposals. Instruction-like lines are flagged and unticked. Nothing is stored in this slice.
- `src/import/importExport.ts`: the preview pass (counts and a plain summary, writing nothing) and the apply pass.
- `src/server/importedHistoryRoutes.ts`, mounted in `routes.ts`: six routes (preview, apply, conversations list, one conversation, projects, search).
  - Apply needs a preview under 30 minutes old of the same unchanged file, and only one apply runs at a time.
  - The Bearer caller gets imported text only inside an `<imported-history>` wrapper that it can't close.
- `src/data/awareness/import-claude-chatgpt-history.md`: tells agents to offer the import, read the preview summary word for word, apply only on the person's yes, and treat results as quoted history.

## Who is affected
Nobody until an import is asked for. The routes do nothing on their own, and no existing route or store changes.

## Not in this slice (later PRs on the same spec)
- the Mac app's "Imported" section, reader and import button;
- meaning-search and app keyword-search sources;
- "Continue this chat";
- storing confirmed facts;
- local Codex and Claude Code session import;
- dropping project files.

## Rollback
Revert. Imported files stay in `<stateDir>/imported-history/`, unused, and can be deleted.

## Decision: the agent may apply after the person's yes in chat
The spec says the person confirms before anything is written. That confirmation reaches apply two ways:
- the owner's session (the app's Import button, in a later slice);
- the agent relaying a yes the person gave in chat after hearing the preview summary. The awareness entry says to read the summary word for word and apply only on their yes.

The agent route is deliberate. Apply only adds the person's own data, keeps it on this machine, and is undone by deleting `<stateDir>/imported-history`. A structural guard backs it: apply needs a preview under 30 minutes old of the same unchanged file. Each apply logs its caller and its `previewId`. The independent reviewer judged this acceptable under "The Person Decides; the Agent Does the Rest".

## Review (independent code review, two rounds)
Round 1 found:
- one high finding: agent apply, answered by the decision above;
- seven medium findings:
  - the manifest rewritten after every chat;
  - duplicates after a crash;
  - an empty entry crashing;
  - file handles leaking on early exit;
  - the end-of-zip search fooled by its own signature in a comment;
  - the scrub's size bound bypassed;
  - double decoding;
- low findings.

All are fixed, with tests. Round 2 found:
- the manifest still rewritten on a re-import;
- a PEM key split across scrub windows.

Both are fixed, with tests (manifest unchanged on re-import; a PEM block across the 1 MB boundary).
