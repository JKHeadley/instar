# The helper script was sent in without its own helper — Plain-English Overview

## The problem in one breath

The fix pipeline builds a small piece of native code, then runs a helper script to double-check the
result. That helper needs a second file sitting next to it — and only the first file was ever copied
in. So the helper died on its very first line, every time, and the pipeline reported "build failed"
even though the build had just succeeded.

## What already exists

Before writing a fix, the pipeline prepares its own copy of the project's dependencies. Two of them
must be compiled. After compiling, it runs the project's own helper script, which verifies the
compiled file actually loads and repairs it if not.

To run that helper inside the sealed workspace, trusted code copies the script in from the exact
version of the project being worked on.

## What this adds

It copies the file the helper itself needs.

The helper's first real line loads a second script from the same folder. Only the helper was copied,
so that load failed immediately — and because it happened *after* the compile had already printed
"rebuilt dependencies successfully", the error that got reported was the cheerful line from the
half that worked rather than the real failure from the half that didn't.

## The new pieces

- The set of companion files is now written down in one place, and all of them are copied.
- If a companion is genuinely missing from the version being worked on, the helper is **skipped**
  rather than run to a certain failure — the compile is what produces the file; the helper only
  checks it.
- A test reads the helper's own first lines and fails if it ever needs a companion nobody declared,
  so this cannot come back when someone adds a third file.
- The error reporting now prefers the failing half of a two-step command over the succeeding half.

## The safeguards

- Nothing about the sandbox changes. The companion is copied by trusted code from the same reviewed
  source as the helper itself, never from the untrusted report or the branch being fixed.
- Skipping the helper cannot hide a broken build: the compile's own exit status is still the thing
  that decides success.

## What ships when

Immediately, always on. No setting, no migration.

## What you actually need to decide

Nothing.
