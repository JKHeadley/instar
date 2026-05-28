# ELI16 — ESM-Safe Instar Hook Generators

## What's broken right now

instar agents come with about 17 small "guardrail" scripts that run automatically — the thing that catches a stuck session, the thing that notices a suspicious package install, the thing that records lessons after a commit, and so on.

Eight of those guardrails are **silently dead** in most agents (everyone whose project is set up in "module mode," which is basically the default and includes the main instar codebase itself). They use an older way of loading their helpers (`require`), and that older way crashes the moment the script runs in module mode. Because the crash exits quietly, nothing ever told us — the guardrails *looked* installed but they did nothing. We only found out when one of them — the very one designed to prevent silent stalls — silently let a session stall for 16 minutes.

## What this change does

Two things, both of which have to land together for the fix to actually prevent the bug from coming back:

1. **Fix the eight broken guardrails at the source.** Rewrite them to use the newer, mode-agnostic way of loading their helpers (`await import` inside an async wrapper), exactly the same pattern the codebase already documents in one *other* guardrail that already does it right. Because of how instar updates work (`migrateHooks` always overwrites these scripts), the fix automatically ships to every agent the next time they update — no separate migration step needed.

2. **Add one test that bans the bad pattern from ever shipping again.** A small unit test reads the source file, finds each guardrail's generated content, and refuses to pass if any of them contains the broken pattern. So if anyone (including a future me) copy-pastes the old way into a new guardrail, the test fails in CI before merge.

The test is the more important half. Fixing eight scripts is good; making sure the ninth one can never join them is the structural win.

## What you'll notice

In your day-to-day: nothing different, because the guardrails are supposed to be quiet. But under the hood, all eight come back to life — including the silent-stall preventer that motivated this whole fix.

For new guardrails added later: if anyone writes one using the broken pattern, CI fails immediately with a precise message naming exactly which generator is wrong and how to fix it. The class of bug literally cannot re-ship.

## Risk

Very low. The change is to script content that's overwritten on every agent update anyway, the fix pattern is one the codebase already used elsewhere (proven), and the regression test gives us a permanent backstop. Rollback is reverting two files.

## Why it ships fast

This is a clear crash bug with an established fix pattern and a structural prevention. The autonomous run is asking for your approval on the spec — the instar-dev gate requires it for any source change. Say go and it merges.
