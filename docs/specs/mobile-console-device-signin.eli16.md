# Owner phone opens the console without the PIN — Plain-English Overview

> The one-line version: when the owner's paired iPhone has just been unlocked with Face ID, the app gets a one-minute, one-use pass from the agent and the console opens signed in, with no PIN box.

## The problem in one breath

Justin opened his agent's console from the Instar iPhone app right after unlocking the app with Face ID, and the console still asked for the dashboard PIN. The phone is already paired with its own hardware key, and Face ID already proved it is him, so the PIN asks him to prove the same thing twice.

## What already exists

- **The PIN unlock.** Typing the PIN on the console swaps it for the agent's access key, which the console keeps and uses for every read. Actions that need extra care (approving things, changing settings) ask for the PIN again each time.
- **Phone keys.** A phone paired with a pairing link or word code holds a private key locked inside the phone's secure chip. It signs every request, and the agent can switch it off at any time (revoke). These phones are deliberately never given the access key to store.
- **The app lock.** The app asks for Face ID, Touch ID or the phone passcode when it opens.

## What this adds

The phone gets a second key in its secure chip that refuses to sign anything until the owner has used Face ID, Touch ID or the phone passcode. When the console opens, the app asks the agent for a one-time challenge, signs it with that key (riding on the Face ID unlock the app just did, so no second prompt), and the agent checks both signatures, checks that this is the owner's phone (not a helper's phone), and hands back a random pass that works once, only for 60 seconds, and only at the address it was issued for. The agent can therefore check for itself that the owner just authenticated; it does not have to take the app's word for it. The app passes it to the console page without ever putting it in a web address. The console trades it in for exactly what a PIN unlock gives, the access key, and nothing more. Actions that need the PIN still ask for it.

## The safeguards

**A revoked phone gets nothing.** It cannot ask for a pass, and a pass it got a moment before being revoked is refused when traded in.

**Nothing extra is handed out.** The pass returns the same key a PIN unlock returns, never the separate "operator proof" used for sensitive actions.

**Nothing is left lying around.** The pass is never in a link, is stored by the agent only as a fingerprint, and is written in the audit log only as a short reference. The console screen on the phone now keeps nothing on disk, and the app clears an access key an earlier PIN unlock had left behind. That is stricter than today, where a PIN typed once in the app stays on the phone even after the phone is revoked.

**Old requests cannot be replayed.** Every pass needs a fresh challenge that the agent forgets after one use or a restart, so a copied request is useless.

**The phone passcode counts like Face ID.** As everywhere on iOS, the passcode is the fallback for Face ID, so someone who watched the passcode and took the phone could open the console; the same person could equally have watched the PIN.

**Helpers and unlocked phones keep the PIN.** A helper's (MSP's) phone, and any phone with no passcode set, still sees the PIN box. If anything goes wrong, the console simply shows the PIN box, as it does today.

## What ships when

One pull request: the agent side (the pass, the trade-in and the audit log), the console page change, and the iPhone app change. No setting to switch on: it works wherever phone pairing already works.

## What you actually need to decide

Nothing new: this builds what Justin asked for in topic 134088. One deliberate change to an earlier rule: the earlier phone design said a phone never gets the agent's access key; in practice typing the PIN in the app already gave it one and kept it on disk. Now the key can reach the phone only after the owner authenticates, and only in memory while the console is open. The other trade-off is that on an agent that has not been updated yet, the app now asks for the PIN each time the console opens, instead of remembering it, because remembering it meant keeping the access key on the phone.
