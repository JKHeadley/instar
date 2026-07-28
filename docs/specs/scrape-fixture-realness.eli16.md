# Plain-English overview — making "test it against the real thing" a rule the computer enforces

## What this is

Yesterday a sign-in link came out broken (it ended in `code=t` instead of the full web address). The cause wasn't sloppy code — it was a sloppy TEST. The piece of code that reads the sign-in screen and pulls out the link was only ever tested against tidy, made-up example text that I typed by hand. But the REAL screen wraps that long link across several lines with no space, and the reader stopped at the first wrap. Every test passed; the real world broke it. You were the one who found it.

This change makes "test it against the real captured thing, not a tidy made-up string" a rule the build enforces automatically — so the next reader-of-messy-text can't slip through the same way.

## What this change does

Three small parts:

1. **A written rule** added to our standards list: a piece of code that reads messy real-world text (a terminal screen, a command's output, a web page) must have at least one test that runs it against a *real captured* sample, not a hand-typed clean one.

2. **A home for real samples.** A new folder, `tests/fixtures/captured/`, holds byte-for-byte real captures, each with a little note saying where it came from (what command, what date, which machine). The rule of the folder: never "clean up" these files — the messiness is the whole point.

3. **An automatic checker.** A small lint runs on every build. It keeps a short, deliberate list of "readers of messy text" (starting with exactly the one that caused yesterday's bug) and refuses the build if any of them lacks a test backed by a real captured sample.

## What already exists vs. what's new

The real captured sample of yesterday's broken screen already exists — it's currently pasted inside the test file. This change moves it into the new real-samples folder and points the existing test at it (the test's check is unchanged: the link must be the full one, not the `code=t` stub). New: the written rule, the folder + its convention, and the automatic checker.

## Why it's deliberately narrow

The checker only watches a short, hand-picked list — right now, just the one reader that already bit us. It does NOT try to guess which of the hundreds of tests are "messy-text readers," because guessing would cause false alarms, and a checker that cries wolf gets switched off. The list grows on purpose, one reviewed entry at a time, as we touch or audit other readers. So it's accurate from day one and never annoying.

## What you need to decide

Nothing structural — this is the direct fix for the process gap that produced the `code=t` link you hit. The only judgment call (made here) is keeping the checker narrow-and-accurate rather than broad-and-noisy.
