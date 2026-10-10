# Unified trust on a machine that joined by pairing (ELI16)

I can run on more than one computer. When a new computer joins, the computer I already run on hands it my identity: the key pair that is my signature and my address. That handover is sealed so only the new computer can open it. The new computer then saves the key in a small file.

**What went wrong.** The code that saves the key on the new computer writes a short version of the file. It has the key itself, when it was made, and where it came from. It does not say whether the private key is locked with a passphrase, because it is not: it is the plain key.

A different part of my code, the one that starts my "unified trust" layer, reads that same file. It only knew two answers to "is the key locked?": "no" or "yes, with this lock". When the answer was missing, it gave up with an error. The server noted the error and carried on, so nothing crashed. But on every computer that joined by pairing, the trust layer never started. That layer keeps the rules about which agents may do what, the tamper-evident log of trust changes, and invitations. So one agent ran two different ways: full trust layer on its first computer, none on the others.

**What this change does.**

- **A missing "is it locked?" answer now means "not locked".** That is what the saving code means, and every other part of my code that reads this file already assumed it.
- **It is only accepted after the key is checked.** The reader already checks that the private key is exactly the right size and that it really belongs to the public key. A scrambled key, a locked key without its label, or two halves that do not match are still refused, and the file is left exactly as it is.
- **A label that is present but wrong is still refused.** Only a missing label is read as "not locked". A label that says something unknown is an error, as before.
- **Two names that were missing are worked out from the key.** The short file does not store my long ID or my short fingerprint. Both are computed from the public key, so every computer gets the same answer.
- **Nothing is rewritten.** The file on disk stays byte-for-byte the same.

Computers that already joined are fixed the next time they start. No setting, no migration, nothing to do.

**What you need to decide.** Nothing. This is a repair with no setting. It ships to every agent at once. If it had to be undone, removing it only brings back the old error; no file was changed.

**Honest limit.** If the first computer's key were locked with a passphrase, pairing would hand over the locked key without its label, and the new computer would refuse it. That is the safe outcome, and no agent is set up with a passphrase today.
