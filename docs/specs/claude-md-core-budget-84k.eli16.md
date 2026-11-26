# Raising the size limit of the always-loaded instruction file (plain-English overview)

## What this is

Every Instar agent has an instruction file, `CLAUDE.md`, that Claude Code loads into every session. Since early November it is kept small on purpose: only the rules an agent needs on every turn stay in it, and each feature's detail lives in separate reference files the agent opens when it needs them. A test guards the small file's size so it cannot creep back up unnoticed. The limit was 80,000 characters.

## What already exists

The small file was about 65,400 characters when the limit was set on 2026-11-03. On 2026-11-14 it measured 79,266. It grew because features add short rows under headings that stay in the small file, mainly the table that says where to look things up ("Registry First", now 12,542 characters) and the list of moments to offer a feature ("Feature Proactivity", 6,356). Claude Code itself only warns at 150,000.

## What is new

The limit becomes 84,000. That is the whole change: one number in the code, the same number in the written design, and a comment saying why.

## Why now

Twelve changes waiting to merge each add a row to the small file. The file had 734 characters of room left. Measured one at a time, each of those changes brought it to between 79,280 and 79,375, so once a few had merged the rest would pass the limit. They would fail the size test through no fault of their own and have to be reworked one after another. On the night this was found, features were already knocking each other out of the test line for a related reason, and this would have added a second one.

## What it costs

Every session of every agent may carry up to 4,000 more characters of always-loaded instructions, one twentieth more than today's ceiling. The file still sits far below the point where Claude Code complains, and an agent's own notes still fit.

## Safeguards

The test still exists and still fails when the file passes the limit, so growth stays a deliberate decision. The comment beside the number records the measurement and says the lasting fix is shorter rows, with the detail moved into the reference files, rather than raising the number again. Going back is a one-line revert.

## What a reader needs to decide

Nothing has to be decided to accept this. The open question for later is whether to cap how long a single row in the small file may be, so the file stops growing by a few hundred characters with every feature.
