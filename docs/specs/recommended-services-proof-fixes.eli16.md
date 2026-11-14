# Fixes from the first live Jev test, in plain words

We ran the setup feature for real on a throwaway agent. A real session signed in to TypeSafe in a normal browser, made a key, stored it without printing it, and passed TypeSafe's real check. The run also showed a few things that need fixing, and this change fixes the ones that can be fixed now.

**The bug.** If someone said no and later said yes again, setup could no longer replace a dead key it had stored itself. The server forgot that setup was where the key came from, so it treated the key as one that was already here and refused to touch it. Setup would have been stuck. The server now remembers where the key came from, even after a no. A key that was here before setup still can't be replaced, which is the protection that matters for features already using it.

**The instructions.** Three things a real session did, or nearly did, are now rules in its brief. It must not leave a key in a shared folder, even for a moment. It must not open an account on a disposable email address, because the account goes when the inbox goes. And it must close each browser window as soon as it's done, because a no can end the session without warning and whatever is open stays open. These are instructions rather than enforcement, so the agent could still get them wrong.

**What this doesn't change.** All of this stays switched off for real agents. Real Telegram and a brand-new sign-up still haven't been proven, because the test used a local stand-in for Telegram and the account already existed. A browser left open by a no is written down as a known limit.
