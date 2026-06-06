<!-- bump: patch -->
<!-- change_type: fix -->

## What Changed

Presence reports no longer confabulate activity from codex's input-box ghost
text. The pane sanitizer (`sanitizeTmuxOutput`) strips input-box lines whose
content is recognizably template text — a `{placeholder}`/`@filename` token or
the known codex suggestion set — before the assessment LLM summarizes the
pane. Real typed-but-unsubmitted commands, prose mentioning the tokens, and
chevron-prefixed output lines are preserved: only text the user never wrote is
stripped.

Why: ANSI-stripping erases the dim styling that distinguishes ghost
suggestions from typed input, so an IDLE session was reported as "preparing to
write tests for the referenced file" (2026-06-06 incident, ledger d0fd5483).

## What to Tell Your User

Nothing user-visible changes unless you were affected: "what is my agent
doing?" answers no longer mistake an idle codex session's input-box example
text for real work.

## Summary of New Capabilities

None — internal correctness fix to presence summarization.

## Evidence

New 6-test suite with the real incident pane as fixture (both sides of every
boundary); all 9 existing presence-proxy suites green (96 tests); tsc clean.
