# Confined Native Rebuild Needs a Writable HOME — Plain-English Overview

## The problem in one breath

The part of the agent that turns a user's bug report into a real pull request could never get
started: it has to compile a small piece of native code first, and that compile failed every
single time, so every real report stopped at "dependencies unavailable".

## What already exists

The feedback executor builds each candidate fix inside a locked sandbox — no network beyond a
tiny allow-list, no credentials, and no reading the rest of the machine. Before it can run the
project's tests it needs `better-sqlite3` compiled for this machine. It prefers to copy an
already-built copy from the agent's own install; when the versions do not match it rebuilds it
inside that same sandbox.

## What this adds

Nothing new, functionally. It fixes why the rebuild could not succeed, and makes the next
failure explain itself.

The sandbox deliberately blocks the whole home folder. But `npm` and `node-gyp` — the tools that
do the compiling — keep their working caches *in* the home folder. So the compiler tried to write
to a place it was forbidden to touch and died with a permission error. Nothing was misconfigured;
two correct rules simply met.

The fix points those tools at a scratch folder inside the sandbox instead. The home folder stays
just as blocked as before; we only stop asking the tools to use it.

## The new pieces

- The rebuild command runs with its `HOME` set to a throwaway directory inside the attempt's own
  temporary space, which the sandbox already allows it to write.
- A small helper picks the one useful line out of a failed rebuild's output and attaches it to the
  error, so the reason travels with the failure instead of being discarded.

## The safeguards

- The sandbox policy itself is untouched: the real home folder is still denied for both reading
  and writing. This changes one environment variable for one command, not the rules.
- The scratch folder lives inside the attempt's temp directory, so it is per-attempt and is thrown
  away with it. Two attempts cannot interfere.
- The failure text is passed through the same secret-scrubbing funnel the rest of this directory
  already uses, and withholds the text entirely if the scrub cannot vouch for it.
- The helper only chooses which existing line to show. It cannot allow, block, or retry anything.

## What ships when

Immediately and always on — this is a straight bug fix, not a feature with a flag. There is no
configuration to set and no migration. If it were wrong, the symptom would be the same
"dependencies unavailable" it repairs, now with the real reason attached.

## What you actually need to decide

Nothing. There is no new setting, no approval, and no operator action.
