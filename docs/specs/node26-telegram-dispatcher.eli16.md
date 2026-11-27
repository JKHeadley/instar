# Telegram works again on Node 26

## What this is

Every Telegram call an Instar agent's server makes goes through one door in the code. That door does one small extra thing: it hands Node's built-in web client a special connection pool, taken from a separate library, so a slow first network address doesn't make a message fail. That pool comes from version 6 of the library. Node 26, the newest Node, carries a newer copy of the same library inside itself, and it refuses the older pool outright. The refusal happens before anything leaves the computer, but it still counts as a failure, so on a computer whose Node is 26 every one of these Telegram calls failed. We found it when a brand-new test agent on the Mac Mini could not even create its own topics.

## What already exists

The door, the special pool, and all the checks around sending (the origin records, the reader-visible text checks, the retry rules for sends that never connected) stay exactly as they are. On Node 24, which most of our machines run, nothing changes at all.

## What's new

When Node refuses the pool in that one specific way, the door sends the same request again straight away without the pool, and remembers for the rest of the process not to offer the pool again. It prints one warning line so the change is visible in the log. The only thing given up is the longer wait per network address that the pool provided; the request itself is identical.

## Safeguards

- Only that exact refusal triggers the second try. It happens before any connection exists, so nothing can be sent twice.
- Any other error, such as a refused or dropped connection, is handled exactly as before and never resent here.
- A request whose body is a stream is never resent, because the first attempt may have used it up.
- The memory lasts only for the running process; a restart checks again.

## What you need to decide

Nothing. It is a small, reversible fix; undoing it restores the old behaviour.
