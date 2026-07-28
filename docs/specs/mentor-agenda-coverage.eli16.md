# Mentor agenda coverage — explained simply

## The everyday version

Your agent can act as a "mentor" to another agent, walking it through a checklist
of things to verify ("check the project map works," "check the reap-log," and so
on). Each time the mentor checks in, it's supposed to assign the next item on the
checklist that hasn't been done yet.

The catch: the mentor decides "what's already been done" by looking back over the
recent conversation — but it only keeps a short window of that conversation in
view. So once an assignment scrolls off the top of that window, the mentor forgets
it ever assigned it, and assigns it again. The result, seen live: the mentor kept
re-assigning the same handful of checklist items over and over (one item got
assigned 14 times), so the mentee kept re-verifying things it had already checked —
and almost never found anything new, because re-checking a working feature rarely
surfaces a bug.

## What we changed

We give the mentor a short, durable list of "items you've already driven recently,"
built from its own recent messages — and this list doesn't scroll away. Now when it
picks the next task, it prefers an item NOT on that already-done list. And if every
checklist item is already done, it simply observes instead of pointlessly
re-assigning. As old assignments age out of the recent window, items quietly become
eligible again — so the mentor still re-checks things periodically (to catch
regressions), just not every single time.

## Why it's safe

The "already driven" list is just a subset of the mentor's own checklist, which it
was already allowed to see — so nothing new is exposed, and the separate "don't leak
internals to the mentee" detector is left completely untouched. When the mentor is
just starting out (nothing driven yet) or has no checklist, it behaves exactly as
before. The change is entirely in how the mentor picks its next task; it doesn't
touch how sessions are spawned or how the mentee is observed. We added tests proving
it prefers fresh items, observes when everything's covered, and behaves identically
when there's nothing to skip.
