# Built-in job templates must authenticate their API calls — Plain-English Overview

> The one-line version: five of your scheduled background jobs have been quietly doing nothing for their entire existence, because their instructions told them to knock on a locked door without the key.

## The problem in one breath

Your agent runs scheduled background jobs — small recurring tasks like "review new improvement proposals" or "harvest lessons learned". Each job has a **doorman check** (does this job have anything to do right now?) and a **body** (the actual instructions). The doorman checks were carrying the agent's key. The instructions were not. So every one of those jobs woke up, correctly decided "yes, there's work here", walked to the door, got refused, and exited — reporting nothing wrong.

The reason nobody noticed for so long is the cruel part: these jobs are *designed* to be silent when there's nothing to do. A job that fails silently and a job that succeeds with nothing to report look **exactly the same** from the outside.

## What already exists

- **The scheduled jobs themselves** — small recurring tasks your agent runs on a timer. They already work as a system; the scheduler, the timing, and the reporting are all fine.
- **The lock on the agent's own API** — nearly every internal endpoint requires a key (a "bearer token"). A handful of endpoints are deliberately public, like the basic health check.
- **The key itself** — handed to every job through its environment. It was there the whole time. The instructions just never picked it up.
- **The update pipeline** — whenever your agent updates, it rewrites its job instruction files from the shipped originals. This matters enormously, and it's covered below.

## What this adds

**The instructions now pick up the key.** Each of the affected job bodies now starts by resolving the agent's key, its identity, and its port, and every call it makes carries them. That's the whole fix — about thirty lines of text across six files.

Alongside the fix, a **build-time check** now scans every shipped job instruction file and fails the build if any of them calls a locked endpoint without the key. Secondary changes:

- One more job (`identity-review`) was reading the key from a **stale source**. On this very agent, that stored copy has drifted out of date and is rejected by the server, while the live one works. It now prefers the live one.
- One job (`reflection-trigger`) had a **second, unrelated bug on the same line**: a quoting mistake that mangled the data it sends into invalid gibberish. Fixed too, since the line was being rewritten anyway.

## The new pieces

- **The build-time check** — reads every shipped job instruction file, finds every call it makes, and asks two questions: is this endpoint locked, and if so, is the key present? It also refuses instructions that *use* a key they never *fetch*. What it is explicitly **not** allowed to do: anything at runtime. It cannot block your agent, delay a message, or stop a job. It is a test. Its only power is to fail a build before broken instructions ever reach you. That line matters — a check this simple must never be given authority over a live agent.

## The safeguards

**Prevents the same bug from shipping again.** The check was proven honest before being trusted: run against the *old* files, it reports exactly the twelve broken calls that actually shipped — not eleven, not thirteen. Run against the fixed files, zero. A check that has never been shown to catch the real bug is just decoration.

**Prevents the check from crying wolf.** The first draft of the check falsely accused three perfectly healthy job files, because they fetch their key in a slightly different but entirely valid style. That was caught, fixed, and locked down with its own test so it can't come back. A check that fails on healthy files gets switched off by the next frustrated person, which is worse than having no check.

**Prevents a fix that only looks like a fix.** This is the trap this change deliberately avoided. Your agent rewrites its job files from the shipped originals on **every update**. So "fixing" the copies sitting on this machine would have worked perfectly — until the next update silently wiped them. That's a fix indistinguishable from a real one, which is exactly the kind of illusion this family of bugs keeps producing. The change is made to the shipped originals, so it reaches every agent through the normal update path and stays fixed.

**Prevents guessing about which doors are locked.** The check doesn't keep its own private list of public endpoints — that would drift out of date. It mirrors the real list and asserts the real one still contains those entries, so if a public endpoint ever becomes locked, the check fails loudly instead of quietly waving it through.

## What ships when

All of it ships together, in one change — the six corrected instruction files and the check that keeps them correct. There's no phased rollout because there's nothing to roll out gradually: the files are either right or wrong, and they're currently wrong.

## What you'll actually notice

Some jobs that have always been silent will **start producing output**. That's the repair working, not a new problem — but it's worth knowing in advance so a suddenly-chatty proposal-review job doesn't read as a malfunction.

## If it goes wrong

Undo the six files and ship the patch; agents pick up the reversal on their next update. Nothing is stored, nothing is migrated, nothing needs repairing. The worst case is a return to exactly today's behaviour — quiet jobs that don't do anything. That asymmetry is the honest argument for making this change: there's almost nothing to lose, and five broken jobs to gain back.
