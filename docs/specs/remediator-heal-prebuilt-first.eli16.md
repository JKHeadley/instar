# Explain it like I'm 16: heal sqlite without needing a compiler

## The setup

Each of our AI agents stores stuff in a tiny database called SQLite. To talk to
it, the agent uses a little piece of machine code (a "native module") called
better-sqlite3. Here's the catch: that machine code is built for **one specific
version of Node** (the JavaScript engine the agent runs on). Node labels its
versions with an internal number — node 22 is "ABI 127", node 25 is "ABI 141".
A module built for ABI 127 simply **will not load** on ABI 141. It's like a
charger with the wrong plug shape — close, but it physically won't fit.

## What went wrong (the Codey outage)

Someone installed a newer Node (25.6.1) on the machine. Our agent "Codey" has a
boot script that, seeing the old Node link was stale, helpfully repointed itself
to the new Node 25 — ABI 141. But Codey's better-sqlite3 was still built for the
old ABI 127. Wrong plug. The database module wouldn't load, the server wouldn't
start, and the system that auto-restarts crashed agents just kept retrying and
failing for **hours**.

The agent is supposed to fix this itself by **rebuilding** better-sqlite3 for the
new Node. There are two ways to get the right module:

1. **Download a ready-made one** ("prebuilt") that already matches your Node —
   takes about 2 seconds, needs nothing special.
2. **Compile it from scratch** — needs a full C++ build toolchain installed, and
   takes ~30 seconds *if it works at all*. On a machine without the compiler, it
   just fails.

## The bug

We have three places in the code that do this rebuild. Two of them were already
fixed (a while back) to **try the fast download first**, and only compile from
scratch as a backup. But the **third** path — the one used by the self-healing
"remediator" — was still hardcoded to **only compile from scratch**. So on a
machine without a C++ compiler (which is most of them), that path could never
actually heal the problem. It would try to compile, fail, and give up. That's the
exact situation Codey was stuck in.

## The fix

Make the third path behave like the other two: **try the fast prebuilt download
first**, and only fall back to compiling from scratch if the download fails. We
also pin the build to use the *correct* Node, so even the from-scratch compile
targets the right "plug shape" instead of accidentally building for whatever Node
happens to be first in line.

## Why it's safe

This isn't a new idea — it's just making the odd-one-out path match the two paths
that already work this way everywhere else, every day. The download comes from
better-sqlite3's official release, pinned to the exact version we already ship, so
it's the same trust level as any normal install. The from-scratch fallback is
still there for the rare case the download can't be fetched. There's a small
honesty note in the spec: the original design document said "prefer compiling from
source," but the safety machinery that would have made that meaningfully safer
(a list of approved file fingerprints) was never actually built — so in reality
*all* our heal paths already download prebuilts. This change just makes the code
say what it actually does, consistently. The proper fingerprint-checking hardening
is written down as future work for all three paths at once.

## How we know it works

New automated tests prove: (1) when the fast download succeeds, the agent heals in
one step and never bothers compiling; (2) when the download fails, it correctly
falls back to compiling from source. All 96 of the existing heal-and-remediator
tests still pass, so nothing else broke.
