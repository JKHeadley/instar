# Recheck a queued owner request against today's phone access

Sometimes the owner's phone asks for something that cannot finish right away, so the request is saved in a sealed queue and carried out later, maybe after the server restarts. When the server comes back, it has no live request from the phone anymore. It only has a saved note of who was let in: the phone's id, a fingerprint of the phone's key, which person it belonged to, and that the person was the owner.

The risk is that the saved note is old. Between saving and running, the owner may have removed that phone, the phone's key may have changed, the person may have been demoted or deleted, or phone pairing may have been switched off. Running the saved request anyway would let an old "yes" outlive the owner's later "no".

This change adds one checker for exactly that case. It takes the saved note and asks today's records the same questions the live phone check already asks: Is pairing on? Are native app conversations on? Is the revocation list loaded? Does the phone still exist, is it active, does it still have the same key, and has that key not been revoked? Is it still assigned to the same person, is that person still the owner, and does the owner's profile still qualify? If any answer is no, or anything cannot be read, the request is refused and the checker says which question failed.

The live check and the new checker now share one set of rules, so they cannot drift apart. The live check behaves exactly as before.

What it does not do: it cannot tell a real saved note from a forged one. Its name says "revalidate a queued snapshot" on purpose, so nobody mistakes it for signing in. The code that unseals the queue must already have proven the note came from this machine. Nothing calls the checker yet. The Conversations work will call it only from its verified sealed-queue runner. No phone, app, or user setting changes.
