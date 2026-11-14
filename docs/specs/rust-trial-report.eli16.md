# Where Rust would (and wouldn't) speed up Instar — plain-English overview

## What this is

The operator asked whether rewriting parts of Instar in Rust, a fast compiled programming language, would bring the big speed and efficiency gains other projects report. This is a written report of what was actually measured, so the answer rests on numbers instead of impressions.

## What it found

Instar's own code is not where the time goes. The agent's server uses about a tenth of one processor core on average. Most of the waiting is on AI models, the network, Telegram and git, which no language change can speed up. Rewriting Instar's roughly 727,000 lines would take months and risk the safety behaviour built up over time.

The real wins were in the development tools, and they have shipped: a natively compiled TypeScript compiler (type-checking 68 → 15 seconds), running our ~50 code checks side by side and stopping one of them repeating work (about 154 → 68 seconds together), tests loading a web-testing library only where they use it, and a small script that no longer waits longer than it needs to.

Two narrow places were tested with real Rust code. In both, a change that keeps everything in TypeScript saves as much or more than Rust would, without maintaining the same logic in two languages. Those two changes are recorded as proposals for future work.

The report also corrects an earlier figure: the messaging helper each session runs uses about 17–45 MB of its own memory, not the 80 MB first quoted.

## What a reader needs to decide

Whether to pursue the two TypeScript-only proposals. Nothing in this document changes how Instar runs.
