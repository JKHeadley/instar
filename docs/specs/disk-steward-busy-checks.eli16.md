# Letting disk cleanup run on a busy machine

## What is going on

The disk steward clears two kinds of cache when a machine's disk gets full: npm's download cache and Xcode's build folders. To stay safe, it skips each one while the tool that uses it is busy. Deleting a cache while a program is writing to it could break that program.

On the Mac Studio those "busy" checks were true all the time, so the cleanup never ran. On 2026-11-18 a cleanup the Chief of Staff approved freed nothing, while about 12.5 GB of npm cache and 5.6 GB of Xcode build data were waiting.

- **npm:** every agent session starts a browser helper with `npm exec`. The check counted any `npm exec` started in the last 30 minutes as busy. Sessions start every few minutes, so npm always looked busy, even though those helpers only download while starting up.
- **Xcode:** the check also counted Xcode's indexing service, SourceKit. It stays running for hours, sometimes a full day, without building anything.

## What changes

- **npm counts as busy for any of these:**
  - an install-type command (install, ci, add, update) ran in the last 30 minutes, as before;
  - an `npm exec` or `npx` is in its first 2 minutes, when it may be downloading;
  - npm's own cache shows a file being written in the last 2 minutes. This one looks at the cache itself, so it catches any download, whatever started it.
- **Xcode counts as busy** while Xcode itself or a build tool is running, but no longer for the idle SourceKit service.

## Safeguards

- If the cache folder can't be read, npm counts as busy and the cleanup waits.
- An open Xcode still counts as busy, because it may build at any moment.
- Only caches are cleared, and both rebuild themselves when needed.

## What needs deciding

Nothing. This is a small, reversible fix built on the Tier 1 path.
