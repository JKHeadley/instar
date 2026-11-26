# Jev memory picker — the plain-English version

## What this is

Every Claude Code session I start loads a list of my saved memories. It is one line
per memory, in a file called `MEMORY.md`. The list has grown to 287 lines, but a
session only reads about the first 25,000 characters of it. That is 117 lines today.
Everything after that is silently dropped. The list is roughly newest-first, so the
dropped part is whatever is oldest, not whatever is irrelevant. In a test on 30 real
conversations, 44% of the memories that mattered sat in the dropped part.

This change adds a step at session start. The step asks Jev, a small, fast model from
TypeSafe, to score each dropped line against what the session is about. It uses the
topic name and the last few messages. Jev answers in about a third of a second.

## What already exists

- The session-start hook, which already prints the topic's recent messages and other
  context when a session starts.
- Two other Jev features on the same account and key (the message-gate signals and the
  job-completion audit). They share the same patterns: a vault key, a kill switch read
  live, secret scrubbing, a metering line per call, and a bounded wait.

## What is new

- A picker that reads the memory list, finds where the load cut falls, and asks Jev to
  score only the lines past the cut. It then picks the top 40, capped at 10,000
  characters.
- **Shadow mode, the default.** It only writes a log line saying which lines it would
  have added. Nothing changes in the session. This is how we find out whether it helps
  before anything is switched on.
- **Inject mode**, switched on later with one setting. The session-start hook then
  prints those 40 lines, so the session sees them.
- A **pinned** marker. Adding `<!-- pinned -->` to a memory line makes it always load,
  even past the cut, without asking Jev. Nothing is pinned automatically.
- An optional short **glossary** of our own names, such as "Sol is a Codex model". Jev
  cannot know that on its own. In the real test, the glossary turned a miss into a hit.

## The safeguards

- It cannot block, send, or change anything. It only chooses which of my own saved
  lines a session sees.
- If anything goes wrong (no key, Jev slow or down, the daily limit reached), it adds
  nothing. The session starts exactly as it does today.
- Secrets are scrubbed from everything sent to Jev. The log records line numbers and
  scores, never the memory text or the message text.
- One call per session start, at most 2 at once, and at most 300 calls a day.
- It is on only for a development agent (Echo), and only in shadow mode. Every other
  agent stays dark. Setting `enabled` to false turns it off at once, with no restart.

## What the reader needs to decide

Nothing now. Justin already approved building it in shadow mode. The later decision is
whether to switch on inject mode, and that decision should be made from the shadow log
lines. One thing to know: the memory lines past the cut now go to TypeSafe too. Until
now only message text did. Those lines name our accounts, machines, and known
weaknesses. They are scrubbed of secrets but not of that content.
