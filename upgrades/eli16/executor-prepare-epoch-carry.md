# Keeping a fix attempt alive when a busy machine renews its own lease

Only one machine may own the feedback queue at a time, and a numbered lease proves which one. If that number goes up, older work is treated as stale and its saves are refused. That rule stops an old owner from acting after another machine has taken over.

There was a gap. On a very busy machine, the server can miss renewing its own lease. It then takes the lease back, and the number goes up, even though no other machine was ever involved. Setting up a fix attempt takes about ten minutes, so a number change during setup is common. The attempt finished setup, passed its safety check, and was then thrown away as stale. We watched that happen live. The records show 13 of these refusals during setup in three days. We traced two of them to a lease change, so the others may have different causes.

Now, while setting up, the attempt checks the number at each step. If it went up and this machine is still the owner, the attempt moves to the new number and carries on. If this machine is no longer the owner, a direct check stops the attempt just before a session would start. Sessions that are already running already had this same-machine behaviour; this extends it to setup. The lease itself is unchanged, so a busy machine still renews this way. Nobody has a decision to make, and a plain revert undoes it.
