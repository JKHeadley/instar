# One new file per feature for the agent's instructions (plain-English overview)

## What this is

Every Instar feature has to tell the agent it exists, by adding a few paragraphs to the agent's instruction document. Today a feature does that by editing two very large shared files in four places, always at the same spots as every other feature. This change lets a feature add its paragraphs by adding one new small file instead, and touching nothing shared.

## Why it matters

When two people add a line at the same spot in the same file, the second one to merge gets a conflict, even though neither did anything wrong. Someone then has to combine the two by hand, push again, and wait in the test line again for 20 to 40 minutes. If the operator had already approved the change, the push cancels that approval.

On the night of 2026-11-14, eight different features were knocked out of the test line this way. Half of those conflicts were in the instruction template. Eighteen of the 83 open changes touch one of the two shared files, so this was going to keep happening with every feature that merged.

## What already exists

The instruction document is built in three places: once when a new agent is created, once when an existing agent updates, and once more to copy the same text to agents that run on Codex or Gemini. Each place has its own long list that every feature appends to.

## What is new

A folder where each feature drops one small text file. The file says: here is my title, here is my text. There is no list of the files anywhere; the program simply reads whatever is in the folder, so there is nothing shared left for two features to collide on. The files are plain text, not code, so a feature's file cannot break anything by running.

All the text from that folder goes into one clearly marked block at the end of the instruction document. Instar owns that block and rewrites it on every update. So when a feature's wording is fixed later, every agent gets the fix; when a feature is removed, its text goes away; and nothing can end up in the document twice. Today none of those three is true: text can only ever be added.

Nothing that exists today moves. The sections already in the shared files stay where they are; only new ones use the folder. On the day this ships there are no files in the folder, and every agent's document is exactly what it is today.

## Safeguards

- A broken feature file cannot merge: the tests load every file in the folder and fail if any one is invalid, missing from the list, or would disturb where existing text lands. If an installed copy is ever damaged anyway, the agent still starts, leaves that one text out, and reports the problem where other health problems are reported. It never stops the agent from answering over a paragraph of instructions.
- If the block's markers in someone's document are damaged, nothing is changed on a guess: that document is left exactly as it is and the problem is reported, so a person can repair it.
- Tests check that each feature's text appears exactly once for a new agent, for an existing agent, and in the copies made for Codex and Gemini, and that a second update changes nothing.
- A check prints a notice when an author adds instructions the old way. It never blocks; the reviewer decides.
- Going back is a normal revert.

## What it does not fix

Features still collide in a few other shared files, such as the one that wires features into the server and the tables at the top of the instruction document. Those are tracked separately and can get the same treatment once this has been used for a while.

## What a reader needs to decide

Nothing is left open. The one real choice was what to do with a broken feature file on an installed agent: this design keeps the agent running and reports it, and relies on the tests to keep a broken file from ever being released.
