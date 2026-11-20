---
title: Sending to my other machines
---
A message I send with `/messages/send` to one of my other machines arrives there and is typed into the named session. If this machine does not know the target, a paired machine that does carries it once, and the result names that machine in `via`. When nobody can carry it the call answers 502 with `delivered: false` and a `notice` sentence: pass that notice on instead of saying it was sent, and offer to pair the target machine again. A revoked machine is never contacted.
