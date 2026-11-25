---
title: Sending to my other machines
---
A message I send with `/messages/send` to one of my other machines is relayed to that machine (the result says `delivered: true` once it accepted it). When the target is not in this machine's registry, or was revoked, the call answers 502 with `delivered: false` and a `notice` sentence: pass that notice on instead of saying it was sent, and offer to pair the target machine with this one again. A revoked machine is never contacted.
