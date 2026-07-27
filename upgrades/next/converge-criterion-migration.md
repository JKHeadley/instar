## What Changed

A correction made earlier today to how design reviews decide they are finished now actually reaches
agents that are already running. It previously did not.

Tools like that review process exist both in what ships and as a copy on each running agent's disk.
The install step deliberately never overwrites an existing copy, in case an operator has customised
it, so an update reaches running agents only through a small dedicated delivery step. One already
existed for this file — but its "have I done this already?" check was keyed to an older change, so
once an agent had taken that one it quietly stopped delivering anything further to the same file.

## Summary of New Capabilities

None. No endpoint, config key, or behaviour is added. This is a delivery step so an existing fix
arrives where it was always meant to go.

Agents that have customised the file keep their version untouched, agents that already have the
correction are unaffected, and a fresh install is unchanged.

## Evidence

The gap was confirmed on a real running agent rather than reasoned about: its copy carried the older
change's marker and did not carry the correction, so the update could never have arrived.

The delivery step was proved to work by simulating exactly that agent — one that already took the
earlier change — and then deliberately breaking the fix in the way that would reintroduce the
problem, which made precisely that test fail and no other.

## What to Tell Your User

Nothing changes in how your agent behaves day to day. A fix that had been shipped but could not
reach already-running agents now reaches them.
