# Console follow-ups — Plain-English Overview

> The one-line version: the new console can now read your learned preferences and find files by name, its live screen hides a kind of API key it used to miss, and every Attention post carries a button to the exact place you act.

## The problem in one breath

The new console pages for "What I've learned about you" and "Files" needed two things the server could not give them: the learned preferences as a proper list, and a way to find a file without opening folder after folder. Separately, the scrubber that hides secrets on the live session screen missed newer Anthropic and OpenAI keys because they have dashes inside them. And Attention posts in Telegram told you something needed you without giving you anything to tap.

## What already exists

- **Learned preferences** — the agent already learns preferences from repeated corrections and injects them at session start, as one block of text.
- **The file viewer** — already lists and reads files under strict rules about which files may never be shown.
- **The live-screen scrubber** — already hides common secret shapes before a session's screen is shown.
- **The Attention topic** — already collects everything that needs you into one Telegram topic.

## What this adds

The biggest change is that anything brought to you is one tap from acting: each Attention post carries a button that opens the exact console page (sign-ins, held replies, safety checks, machines, feedback, shipping), and a post with no possible button is written to a log so the agent that raised it can be fixed. The post itself always goes out.

- The console can read your learned preferences as a list (what, when, how sure, which machine), with any secret-looking text removed.
- The console can search for a file by name, under the same rules as the rest of the file viewer, and it stops early and says so on very large folders.
- The console's Files page can preview images.
- The live-screen scrubber now catches keys like `sk-ant-api03-…` and `sk-proj-…`.
- Existing agents learn about the two new reads on their next update.

## The safeguards

Every new read is read-only. File search reuses the file viewer's own rules, so a file that may never be shown never appears in results. The image change applies only to the new console, not the old dashboard. Buttons only ever point at the console through the public tunnel address, never a local or insecure address. Nothing is held back or blocked.

## What you need to decide

Nothing. This was already built and tested; this commit records the review the build skipped.
