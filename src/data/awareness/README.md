# Awareness entries

Each file in this folder is one piece of agent-awareness text. Instar reads the
folder when it builds an agent's instruction document and puts every entry in one
`## Feature notes` section, for new agents, existing agents and the Codex/Gemini
copies alike. A wording change in a file reaches every agent on its next update,
and deleting a file removes its text.

**To tell agents about a new feature, add ONE file here.** Do not add awareness
text to `src/scaffold/templates.ts` or to `patchClaudeMdContent` in
`src/core/PostUpdateMigrator.ts`. There is no list of entries to edit anywhere.

Spec: `docs/specs/awareness-entry-registry.md`. Reader: `src/awareness/registry.ts`.

## Format

File name: `<id>.md`, where the id is lower-case letters, digits and single
hyphens (`held-replies.md`). This `README.md` is skipped. Any other `.md` name is
an error.

```
---
title: Held replies delivered late
requires: telegram
---
A reply held for review is delivered late and marked as late. Check with
`curl http://localhost:{{port}}/messages/held`.
```

- `title` (required): one line. It may contain a colon. It may not contain `**`,
  `*` or an em dash. It must differ from every other entry's title (ignoring
  case) and from the title of every existing section of the instruction document.
- `requires` (optional): the only value is `telegram`. The entry is then written
  only for agents that have Telegram configured.
- No other front-matter key exists. Lines are `key: value`, with no quoting.
- The body is plain markdown. `{{port}}` is replaced with the agent's port,
  inside code fences too. No other `{{...}}` placeholder exists.

## Rules for the body

Instar writes the entry as `**<title>** — <body>`, so the title and the first
line of the body share one line.

- **The first line of the body must be prose.** A code fence, list item, heading,
  quote or table cannot start there. Put them on later lines.
- No heading (`## ...`) and no second bold lead-in (`**Name** — ...` at the start
  of a line) anywhere in the body outside a code fence: an entry is exactly one
  section.
- Every code fence that is opened is closed.
- The text `instar:awareness-registry` may not appear.

An entry that breaks a rule is left out and reported; the other entries are still
written. `tests/unit/awareness-entry-registry.test.ts` fails on a broken entry in
this folder, which is what keeps one from merging.

## Your trace must list the entry file

An entry file lives under `src/`, so the merge-time decision audit requires it in the
`coveredFiles` of an instar-dev trace on the branch. Write the trace AFTER the entry file
exists and put the file in `--files` (for a flagged PR: the one whole-PR trace, committed
last). A PR that forgets passes its full verify and is then refused at merge with
`decision-audit: uncovered: src/data/awareness/<id>.md`, and needs a push and a second
verify (two features on 2026-11-15).

## Size

Every title is named in the short capability list at the top of the instruction
document, which has a size limit (`CLAUDE_MD_CORE_BUDGET_CHARS`). Keep titles
short. Two entries merged separately can together pass the limit; the size test
on main reports it.

## What an entry cannot do

An entry can vary only by `requires: telegram` and `{{port}}`. It cannot add a
row to a table under one of the core headings; those still live in
`src/scaffold/templates.ts`.
