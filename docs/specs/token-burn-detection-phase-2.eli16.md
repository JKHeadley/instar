# Token-Burn Detection — Phase 2 ELI16

## What this ships

The second piece of the bleeding-detector. Still no user-visible change — phase three is where the watcher actually starts watching.

What this phase adds is the piece that figures out, after the fact, which component made an LLM call. The Claude CLI's session files (the JSONL log that the token ledger already reads) record every LLM call, but they do not say "this call came from InputDetector" or "this came from MessagingToneGate." The Phase 1 chokepoint can tag the few calls it makes directly, but the dominant case is the CLI path, and that path's logs do not carry our component label.

Phase 2 closes that gap with two small pieces:

1. **A short list of patterns** that match the prompt shapes the agent's internal components use. Today the list has nine entries — the InputDetector bleed shape (the very prompt that burned 3B tokens), MessagingToneGate, CommitmentSentinel, MessageSentinel, StallTriageNurse, CoherenceReviewer, ProjectDriftChecker, ResumeValidator, and TopicLinkageHandler. Adding more entries is easy and does not need any spec change — they are inference rules, not authority.

2. **A pure function** that takes one log entry and returns a stable "attribution key" like InputDetector::a1b2c3d4. The function tries prompt-pattern matching first, then falls back to working-directory inference (a path under `.instar/jobs/foo` becomes "user-job:foo"; a hook file becomes "user-hook:<file>"), and finally falls back to "unknown::<short session id>" so a single misbehaving session still groups into one key.

The function is pure: no files read, no clocks, no side effects. Same input always gives the same output. The bleed detector in phase three will lean on that determinism heavily.

## What you'd notice if it went wrong

Nothing on its own — the function is not called by anything in production yet. Worst case: a prompt that matches multiple manifest entries attributes to the first-listed one. The test suite documents this behavior with a specific test (the bleed pattern matches before the generic stall pattern, by design).

If a manifest entry is incorrect, the worst outcome is a misattributed key — the bleeding event would still be observed under the wrong component name, and the user would see "I think this is InputDetector burning, but I'm not sure" in phase three's alert. The umbrella spec's "attribution-key mismatch" mitigation handles that case in phase six (verification step re-samples and flags it).

## How we know it works

Twenty-two tests in `tests/unit/burn-detection-phase-2.test.ts`. They cover: every manifest entry resolves to its component on a representative prompt; the 2026-05-15 bleed shape resolves to InputDetector; scheduled-job paths resolve to user-job; hook paths resolve to user-hook; Windows-style backslash paths work; empty / unknown events fall back cleanly; first-match-wins is preserved.

The manifest itself has integrity tests: no duplicate component names, every entry has at least one matcher, no empty component names.

## What's next

Phase 3 is the actual detector. It polls the token ledger every 60 seconds, calls this attribution resolver on each event, computes per-key rates over rolling windows, and emits a signal when a single key crosses 25% of the 24-hour budget or doubles its 7-day baseline rate. That signal feeds the existing Remediator V2 dispatch — no new authority surface gets added.

Phase 3 will be the first phase where you, Justin, see something visible: the new signal will land in the existing degradation log, which is dashboard-visible. Still no Telegram alerts yet — those land in phase five with the principal-bound buttons.
