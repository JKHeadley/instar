# Machine names and the model in reply footers — plain overview

## What the operator saw

On 2026-11-12 Justin sent a screenshot of a reply from the agent Bob. Under the message, the footer read `bob · Machine m_4851af · Claude Code · unknown`. Two things were wrong. The machine was shown as a raw id instead of a name a person would recognize. And the model, which for a Claude Code session is always something concrete like Claude Opus, was shown as the word "unknown". Other agents showed the same thing that day (Inspec, and Indra on Slack with "unknown harness · unknown model"), so it was a fleet problem, not one agent.

## Why the machine had no name

Instar already gives a machine a nickname when it registers itself, but only at that moment. Machines registered before nicknames existed, or whose registry was rebuilt by a path that skipped them, never got one, and nothing ever went back to fill the gap. The footer then had nothing to show but the id.

## What changes for names

- When a machine sets itself up (init, setup, or the first boot after pairing), it now takes the name its owner already gave the computer: on a Mac, the name from Sharing settings (for example "Justin's MacBook Pro"); on Linux, the pretty hostname; otherwise a tidied hostname. No question is asked, and the owner can rename it at any time.
- Every boot and every update fills in a name for any machine that has none. A name a person typed is never replaced. A name another machine guessed from our hostname at pairing is upgraded to our own computer name the next time we boot.
- Names travel to the other machines through the same registry sync that already carries them.

## Why the model said "unknown"

The part of Instar that reads a session's transcript to learn which model wrote a reply read the file in 256 KB steps. Claude Code puts a whole screenshot or a large tool result on a single line, often bigger than that. When one line was bigger than a step, the reader gave up on it, then misread the rest of that line as a broken record and marked the whole session as unreadable for the rest of its life. From then on, every reply from that session fell back to the model the session was launched with, and a session launched on the account default has none recorded, so the footer said "unknown". On Luna's machine 76 recorded replies carried exactly this cause. A second, smaller cause: at send time the reader took just one step, so a session with more than 256 KB of new transcript since its last read also answered "unknown".

## What changes for the model

- A long line is now kept across reads and read whole, up to 16 MB per line. A line larger than that is skipped on its own, and only the current turn reads as not known; the next turn is read normally again. A session is never poisoned for good.
- At the moment a reply is sent, the reader catches up on the whole unread part of the transcript (bounded at 16 MB) before answering. The background poll keeps its small step.
- Three more ways the reader lost a session were fixed. A session's very first reply could come before Claude Code had told Instar which transcript belongs to it; the send now looks that up from Claude Code's own small per-process file. Sessions working inside a topic worktree keep their transcript in a folder named after that worktree, and after a server restart Instar looked in the agent's home folder instead and never looked again; the spawn record now remembers the worktree, the reader looks in neighboring folders for the session's own file name, and a missing file is searched for again. Codex keeps thousands of old session files, and the search gave up before reaching today's; it now looks at the newest days first.
- When a field still truly cannot be known, the footer leaves it out instead of printing "unknown", on Telegram and Slack alike. The record behind the footer still says exactly what was unknown and why.

## What a reader needs to decide

Nothing. This is a fix of existing behavior. It is reversible: reverting the code returns the old reading and the old footer words, and any names it filled in are ordinary nicknames that stay editable.
