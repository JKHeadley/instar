# A machine on a git folder with no remote asks before taking charge

## What this is, in plain words

When two machines run one agent, they agree on which one is in charge through a "lease". The earlier fix (#2912) stopped two machines restarting each other every 15 minutes. Its main rule: a machine that has just restarted asks the other machine before taking charge, if their lease copies are not kept in a shared place. That rule only switched on for the plain lease file.

While checking that fix live on the test pair nimbus and proof-2, it turned out the pair is mixed. nimbus keeps its lease in a plain file. proof-2's agent folder is a git repository with no remote, so its lease lives in git, which the rule did not cover. A git repository with no remote shares nothing with the other machine either. So after a restart, proof-2 took charge without asking while nimbus was still in charge, both held the same lease, and one of them restarted. Four deliberate restarts produced two extra restarts this way.

## What changes

A git lease store now says it holds only this machine's copy when its repository has no remote. The coordinator then applies the #2912 rules to it as well. The main one is to ask the other machine before taking charge. If the other machine answers with a live lease, there is no claim and no tie. If nobody answers, it tries to take charge exactly as before. The answer is checked at most once a minute, so adding a remote takes effect within a minute, with no restart.

## What already exists and stays the same

Machines whose git folder has a remote behave exactly as before. A git machine with no remote still cannot take charge through git unless the separate takeover switch is on, as before. Nothing about who may hold the lease changes.

## Safeguards and evidence

Tests on both sides: with no remote, it asks first and a live lease stops the claim. With nobody answering, it still tries. With a remote, or when the remote list cannot be read, it does not ask, as before. Turning the new answer off makes five tests fail. The existing lease tests at every level still pass, including the flap measurement harness, with no row changed.

A different idea was dropped after review: undoing a failed claim inside the git store. It could leave two machines with no remote and nobody in charge. On a machine with a remote it could even lower the lease number. It also falls under a design question already tracked separately (CMT-1226).

## What to decide

Nothing. This is a small fix that a revert fully undoes.
