<!-- bump: patch -->
## What Changed

- **The attention lifecycle's security floor now recognises two shapes it missed** (`src/core/AttentionLifecycle.ts`). A rotate-this-secret ask whose secret word sits inside an identifier ("Rotate github_token …") and a live grant on someone else's account ("… OAuth …", "authorization for someone else") are now classed `security`, so the hourly pass never expires them. "exposure" now matches alongside "exposed". Measured on 2026-10-26 against all 4,522 attention rows on four machines: the change adds exactly the two rows that were missed and nothing else.

## What to Tell Your User

Two kinds of security notice could have been closed as "expired" by the new attention cleanup: a request to change a password or key when the key's name was written as one word, and a warning that this machine holds access to someone else's account. Both are now treated as security items, which are never closed for you.

## Summary of New Capabilities

- None; a wider match for the existing never-expire security class.

## Evidence

- 2026-10-26 one-time cleanup review (`docs/audits/attention-noise-sweep-2026-10-25.md`): "Rotate github_token (printed into a session transcript)" and "Active email authorization for someone else on this machine" were classed operator-asked and listed to expire; both were handled by hand before the live run.
- Tests: `tests/unit/AttentionLifecycle.test.ts` (both titles plus an OAuth case are security; four ordinary notices are not).
