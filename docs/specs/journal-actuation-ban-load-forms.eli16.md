# ELI16 — the journal ban that only knew one way to say "import"

## The rule being protected

Instar keeps a **journal** — a log of things that happened, copied between your machines. Copies arrive on a
heartbeat, so a copy is always a little bit behind reality. That is fine for answering questions ("what happened
to this conversation?") and dangerous for making decisions.

The dangerous case is concrete. Suppose a part of the system that can **kill a session** reads the copied journal,
sees "session closed", and acts on it — but that entry is thirty seconds stale and the session is alive and
working. It kills live work. Or the reverse: it sees no session and starts a second one, and now the same
conversation runs twice on two machines. Those are real incidents Instar has had, and the journal exists to help
diagnose them. If the journal caused them instead, it would be worse than useless.

So the spec has a rule (§3.9): anything that can **kill, spawn, place, transfer, or reap** may *write* to the
journal, but may never *read* it. Read the live system instead. To make that rule mechanical rather than a thing
people remember, the reader lives in its own file, and a lint fails the build if one of those modules imports it.

## What was broken

The lint looked for the word `from`:

```js
/from\s+['"]…CoherenceJournalReader…['"]/
```

That matches `import { X } from '…Reader.js'`. But JavaScript has two other ways to load a module, and **neither
uses the word `from`**:

```js
const mod = await import('…Reader.js');   // dynamic import
const mod = require('…Reader.js');        // require
```

Both load the reader completely. Both walked straight past the guard. I appended a dynamic import to a real
listed actuator and ran the shipped lint: it printed `clean`. Another agent, Codey, found the same hole
independently while auditing about twenty of these checks, and ranked this one **first** by how much damage its
defeat would do — precisely because the failure is false kills and duplicate sessions.

This is not an exotic bypass. `await import(...)` is ordinary, and the codebase uses it constantly to avoid
loading heavy modules at startup. Someone could defeat this guard by accident, while writing perfectly normal
code, and nothing would tell them.

## What changed

The check now recognises all three loading forms. Three smaller things came with it, and two of them make the
lint *less* likely to complain, not more:

1. **Comments are removed before checking.** Otherwise, widening the pattern would make it illegal to *write
   about* the rule — a comment saying "never `await import('…Reader.js')` here" would itself fail the build. The
   stripper understands quotes, so a `//` inside a string is not mistaken for a comment, and it preserves line
   numbers so error messages still point at the right line.
2. **`import type` is now allowed.** TypeScript's `import type` disappears entirely when the code compiles — it
   borrows a *shape*, not the actual reader — so it cannot act on stale data. The old pattern flagged it. There
   is a real file in the tree doing exactly this legitimately.
3. **A listed file that no longer exists is now an error.** The old code skipped missing files silently, so
   renaming a guarded module quietly removed it from the ban and the lint still reported clean.

## The bug I put in myself, and caught

My first attempt tried to *discover* actuators automatically instead of using a hand-written list. I tested it by
pointing it at another copy of the repo, and it said `clean`. That looked like good news. The path I gave it did
not exist — it had scanned zero files and reported success. A "clean" result over nothing looks identical to a
genuinely clean result, which makes it the most misleading output a checker can produce. The lint now refuses to
give a verdict at all if there is no source directory to scan.

## What I did NOT fix, and why

The list of guarded modules is still written by hand, so a brand-new actuator is not covered until someone adds
it. I built the automatic version, ran it against the real code, and threw it away, because it flagged nine
places and **every single one was wrong**:

- Files with names like `readReaperPeerText` and `reaperPoolHealth` — code that *reports on* the reaper, not code
  that reaps. "Reaper" there is a noun, not an action, and reporting code reading the journal is exactly what the
  journal is for.
- The 22,000-line file that wires the whole server together. Every module's abilities pass through it, so calling
  the file as a whole "an actuator" is meaningless.
- A file whose only sin was the `import type` described above.

This lint blocks commits. A guard that stops correct work is more expensive than one with a known, written-down
gap — especially when the gap was a deliberate design choice recorded when the check was first built. So it stays
hand-maintained, the limit is stated plainly at the top of the file instead of being quietly implied, and a test
pins the gap so that if anyone ever closes it properly, that test fails and tells them to update the docs.

## How you know it works

Every new assertion was run against the *old* lint first to prove it could fail: five of the thirteen tests fail
without the fix, and the eight control tests — writer imports are fine, comments are fine, reporting modules are
fine — pass with and without it, which is what makes them controls rather than decoration. Against the real
repository the lint reports clean and blocks nothing.

## One thing for a human to decide

While the discarded auto-discovery was running, it pointed at five places in the server file that load the
journal reader dynamically. One of them builds ownership records for conversations *from the copied journal* —
which then influences where sessions are placed. It is deliberate, documented, and it double-checks its input
against live data first. Whether §3.9 permits it is a genuine question about what the rule means, not something a
lint should decide, so it is written up and handed to the operator rather than quietly changed or quietly
ignored.
