# Locked-Mac proof fixes, in plain words

## What this is

Instar can (once proven, and only when an owner turns it on) let you open a locked Mac from your phone: you see the lock screen, type your Mac password into a box, and the Mac relocks when you are done. Before any Mac is allowed to do this, we run a proof on a spare Mac with a throwaway user. On 4 November that proof, run on the Mac Mini, found three real problems. None of them could leak a password; each one made Instar look fine while it was actually stuck.

## What was wrong, and what changes

**1. The helper gave up silently on a fresh Mac.** Instar's small Mac helper keeps a record of "this Mac must be relocked" in a folder under your home. It only made the last folder in that path. On a test build, the folder above it did not exist yet, so every save failed, and the helper quit without saying why. Instar then answered "the helper is unavailable", which told nobody anything. Now the helper makes every missing folder (private to you, like the rest), and when it does fail it says why in one fixed word, such as "store-root-uncreatable". Instar passes that word and the exit number along, so the error says what actually went wrong. Only those fixed words get through: nothing you typed and no file paths.

**2. Status said "ready" when the password box could not work.** The status page said everything was fine while the box was impossible, for two reasons: the secure tunnel was down (Cloudflare had rate-limited it), and this install did not have the kept helper that password typing needs. The page simply hid the box. Now the status says, for the app and for the browser separately, whether a password could be typed once the Mac is locked, and if not, why: for example "tunnel not active" or "kept helper required". The viewer shows that sentence instead of a blank space. And when the tunnel comes back, any open viewer is told straight away, so the box appears without reconnecting.

**3. Agents without Telegram never got a dashboard PIN.** The PIN is what unlocks the dashboard's owner controls. Instar only created one while setting up Telegram, so an agent without Telegram could never use those controls. Now every agent gets a PIN at start if it has none. An agent that already has a PIN keeps it exactly as it is, even if its secret store is briefly unreadable. The PIN is no longer printed in the start-up log.

## What stays the same

The locked-screen feature is still off everywhere and still cannot be turned on for any macOS version until the real crash and Stop tests have passed. The Mac itself still refuses a password whenever anything is not ready; the new status words only explain what it would refuse. Nothing here stores or sends a password.

## What you need to decide

Nothing. This repairs what the proof found, so the proof can be run again.
