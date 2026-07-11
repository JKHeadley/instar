# Visible automated mentor delivery

## What Changed

Successful same-machine mentor prompts delivered through `/a2a/inbox` are now mirrored into the configured mentor Telegram topic. The mirror is best-effort and cannot change canonical delivery success, ledger writes, outstanding-prompt state, or anti-ping-pong behavior. Messages are line-aware chunked under Telegram's 4096-character cap, limited to three posts, and report an honest partial failure without retrying.

## Evidence

- Boundary and chunk-order tests cover 4096, 4097, 9000, and pathological prompt sizes.
- Failure, opt-out, missing-bot, local-only, config hot-read, mentor-runner, and reply-regression tests pass.
- Build and docs-coverage pass.

## What to Tell Your User

Automated mentor prompts are now visible in the mentor chat topic instead of arriving invisibly through the server while only the mentee's reply appears. Long prompts are safely split into a small ordered sequence.

## Summary of New Capabilities

- Visible `[mentor]` echo for successful local inbox delivery.
- Default-on `mentor.visibleEcho` off-switch.
- Telegram-safe ordered chunking with a three-message flood cap.
- Honest degradation reporting for partial or failed visible mirrors.
