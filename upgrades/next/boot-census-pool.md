# The restart census reads every machine

<!-- bump: patch -->

## What Changed

The list of conversations that stopped at each restart can now be read for every machine in one call. Marking a machine's list as reviewed now goes to the machine that holds it. The daily stewardship pass can therefore keep track of every machine's restarts, and each machine can prune its own reviewed lists.

## What to Tell Your User

- **Restart lists for every machine**: "My daily check now sees which conversations stopped at each restart on all of my machines, not only this one."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Pool-wide restart census | `GET /sessions/boot-census?scope=pool` |
| Mark another machine's census reviewed | `POST /sessions/boot-census/reviewed` with `machineId` |
