# Small CLAUDE.md — the plain-English version

## What is wrong today

Every instar agent has a file called CLAUDE.md. Claude Code reads the whole file at the
start of every session, before the agent does anything. Over time instar added one
section to that file for every feature it shipped, so that agents would know the feature
exists. There are now about 300 of those sections, and the file is about 570,000
characters long. That costs roughly 120,000 tokens per session for every agent, and
Claude Code itself warns at session start that the file is over its 150,000-character
limit. Nothing in the file is a duplicate; it is simply everything at once.

## What changes

The file is split in two.

1. **CLAUDE.md keeps everything the agent needs in every session**: who it is, its
   memory, how to survive compaction, how to call its own server, how to report bugs,
   "check before you say you can't", its core principles and anti-patterns, how to talk
   to people, how to reply on Telegram, and the rules it has to apply on every turn
   rather than look up (the traps it tends to fall into, when to offer a feature to the
   user, which state file answers which question, the outbound-message rules). At the
   end there is a short table, "when the work touches X, read file Y", and a list that
   names every other capability in one short line per topic. So the agent still sees
   the name of every capability in every session. The new file is about 65,000
   characters for a new agent.
2. **The detailed text of everything else moves into reference files** in
   `.instar/reference/`, grouped by topic (the iPhone app, talking to other agents,
   messaging, multiple machines, accounts and models, sessions and jobs, autonomy and
   promises, the dashboard and the web, safety and monitoring, development, learning and
   memory, principles, other). Big topics are cut into parts so each file can be read in
   one go. An `INDEX.md` lists every section and which file it is in. The agent reads
   these when a task needs them, the same way it already reads other files.

Nothing is deleted. Every section of instar's text is either still in CLAUDE.md or in
exactly one reference file.

## What already exists and stays the same

Instar developers keep adding feature awareness in the same single place
(`generateClaudeMd`). The split happens automatically, so a new feature's section lands
in a reference file and its name appears in the always-loaded list. A test fails if
CLAUDE.md itself grows past its budget (80,000 characters), so it cannot quietly creep
back up, and another test fails if someone adds a sub-section inside an always-loaded
section without deciding where it belongs.

An earlier attempt at a small CLAUDE.md (in March) was a second, hand-written template
that nobody kept up to date, and it relied on the agent remembering to ask its server.
This design avoids both: the small file is produced from the full one by code, and the
reference files are ordinary files.

## Existing agents

On their next instar update, existing agents are converted:

- the old CLAUDE.md is copied to `.instar/CLAUDE.md.before-reference-layout.md` first;
- anything the operator or the agent wrote into CLAUDE.md themselves stays in CLAUDE.md,
  below the instar part. A section with an instar title but the agent's own words, like
  a personalised "Who I Am", stays too;
- if an instar section had a few lines that differ from instar's current text (usually
  older instar wording, sometimes a hand edit), those lines are listed in
  `.instar/CLAUDE.md.differing-lines.md`, and CLAUDE.md gets one line pointing at it;
- the instar part is replaced by the small version, and the reference files are written.

After that, every update rewrites only the instar part between two marker comments and
the reference files. The operator's own notes are never touched. If an older version of
instar later adds its old sections back below the instar part (after a rollback, or from
another machine still on an older version), the next update takes them back out, after
saving a copy of the file.

## Measured on real agents

On copies of three real agents the file went from about 465,000 characters to
85,000–93,000. The part above the 65,000-character core is each agent's own sections,
which are kept.

## Safeguards

- When in doubt whether a section was written by instar or by the operator, it is kept.
- The full old file is always backed up before the first change.
- Setting `claudeMd.layout` to `"full"` in `.instar/config.json` puts the whole document
  back into CLAUDE.md on the next update. This is the way to roll back.
- Reverting the instar release alone brings most sections back but not all of them; the
  backup file holds the rest, and the spec says how to restore it.

## What a reader has to decide

Nothing beyond the defaults: the reference layout is on by default, with the off switch
above. The size budget (80,000 characters, about half of Claude Code's limit) and the
location (`.instar/reference/`, which Claude Code never loads by itself) are chosen so
Claude Code never warns and the agent keeps every rule it uses on every turn.
