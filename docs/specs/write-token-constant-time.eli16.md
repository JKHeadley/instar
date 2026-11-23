# The key another machine uses to submit changes is checked in constant time (ELI16)

When an agent runs on more than one computer, a secondary computer can send a state change to the main one. To prove it is allowed, it sends a write key that the main computer gave it earlier. The main computer looks the key up in its list of issued keys.

That lookup used an ordinary text comparison. An ordinary comparison stops at the first character that differs, so a wrong key that starts with the right characters takes a tiny bit longer to reject than one that is wrong from the start. Someone measuring those tiny differences over many tries could in principle learn the key a character at a time. In practice this is very hard here, because only a caller who already holds the agent's main key can reach this check at all. So this is an extra layer of safety, not a fix for an open door.

Now both keys are turned into fixed-length fingerprints and compared with the standard constant-time check, which takes the same time no matter where they differ. Every key in the list is checked, so even the number of issued keys does not show in the timing. A damaged entry in the list is skipped instead of crashing the check. Nothing changes for machines with a valid key: they are accepted exactly as before, and revoked keys are still refused.
