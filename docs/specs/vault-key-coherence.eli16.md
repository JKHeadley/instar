# One vault, one key, always explainable — the plain-English version

## The disease this kills

Your secrets vault is an encrypted file, and the key to it can live in two
places: the Mac's keychain, or a small key file next to the vault. The old
design had a landmine: the keychain slot was SHARED by every agent on the
machine, and anything that created a fresh vault (a test, a new agent) would
generate a new key and silently overwrite that shared slot. Result: half the
readers suddenly had the wrong key — and instead of saying "wrong key," they
reported the vault as EMPTY. That's the heart of "I've given you this secret
MANY MANY times": the secrets were there the whole time, just invisible to
whichever reader grabbed the wrong key.

## The three fixes

**1. Every agent gets its own keychain slot.** The slot name now includes the
agent's home path, so two agents can never clobber each other. An agent still
using the old shared slot adopts its key into its own slot automatically the
first time it reads — nothing for you to do. And nothing ever writes the old
shared slot again.

**2. The vault file now says which key opens it.** New vault writes stamp a
short fingerprint of the key into the file header. A reader with the wrong
key now gets a precise error — "this vault needs key 3f9a…, you have 7c01…"
— instead of pretending the vault is empty. Wrong-key and actual corruption
are now different, diagnosable errors. (Old vault files still read fine.)

**3. Readers try both keys before giving up.** If the keychain and file keys
have drifted apart, a reader that fails with one key tries the other. If the
backup key works, you get your data — plus a loud note in the degradation log
that the keys have diverged. The next time anything writes to the vault, it
re-encrypts with the primary key, which quietly heals the split.

Bonus: the sync status page now distinguishes "the vault is empty" from "the
vault has data but the key is missing" — the exact confusion that hid this
bug for weeks.

## What you'll notice

Nothing — which is the point. Secrets you hand me stay readable by every part
of me, on every machine, forever. If the keys ever do drift, I keep working,
tell the log exactly what happened, and self-heal on the next write instead
of asking you to send the secret again.

## What did NOT change

The encryption itself (AES-256-GCM), where the vault lives, the one-time drop
links, and the rule that tests can never touch your real keychain.
