# ELI16 — a second machine can no longer start up pretending to be the first

## What was wrong

Every machine an agent runs on has its own identity: a machine ID plus a private key that only that machine holds. The machines use these to recognise each other and to agree on which one is in charge.

When Luna was set up on the Mac Studio, the Studio started from a copy of the laptop's agent folder, and that copy included the laptop's identity file. When "instar join" ran on the Studio, it saw an identity file, printed "This machine already has an identity. Using existing.", and carried on. So the Studio claimed to be the laptop. Two machines with the same name confuse everything that depends on telling them apart. Luna reported this on 3 October (tracked as ACT-1302). The leftover record of it is part of what made the Studio send messages to itself.

## What changes

- The machine being joined (the first machine) now checks the identity it is offered. If it is its own, it refuses with a clear error. This does not use up the joining code.
- The joining machine checks whether it actually holds the private key for the identity file it found. If it doesn't, it first asks its own secure keychain to rebuild the key. That way a genuine machine that merely lost its key files keeps its identity, which is how the existing recovery feature is meant to work. Only when that fails is the file treated as a copy from another machine.
- A copy is never deleted. It is renamed and set aside, and the machine creates a fresh identity of its own. If the first machine refuses the join as described above, the joining machine does the same thing and tries the join once more.

## What you need to decide

This is a bug fix with no decision for the operator.
