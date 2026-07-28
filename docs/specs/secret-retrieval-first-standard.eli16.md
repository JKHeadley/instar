# ELI16 — Secret-Retrieval-First Standard

**The mistake:** When I needed a secret (a feedback webhook key), I asked the operator to hand it to me through a secure "Secret Drop" form. He pushed back — hard — because that secret was already sitting in *his own Vercel account*, which I have full access to. I could have just gone and gotten it myself. Making him stop and fish out a "random secret" was annoying and unnecessary. He called it a user-experience violation, and he's right.

**Why it happened:** My instructions (the CLAUDE.md template every Instar agent reads) literally told me the wrong thing. They said: "the moment you realize you need a credential, use Secret Drop — it is the ONLY correct way to collect a secret." So I followed the instructions and bugged the user. The bug wasn't in my judgment in the moment; it was baked into the standard.

**The fix:** Flip the default. The new rule, written into the template and pushed to every agent, is:
1. **Get it yourself first.** Look in the places you already have access to — your encrypted vault, a Vercel project, GitHub, a cloud console. If the secret is in one of the operator's accounts, it's yours to fetch. (Be careful with it: grab only the one value, never print it, delete any temp file right after.)
2. **Only ask the human as a last resort** — when the secret genuinely lives somewhere you can't reach (something only they hold). Even then, don't assume they have it handy: either send the one-time Secret Drop link, or walk them through getting it in a phone-friendly, step-by-step way.
3. If the user *offers* you a secret unprompted, Secret Drop is still the right way to take it (never let them paste it into chat, never make them edit a file).

**Why it sticks (not just willpower):** I didn't just promise to "remember." I changed the template so new agents are born with the right rule, AND added a migration that rewrites the old harmful sentence in agents that are already running. So every Instar agent — old and new — now defaults to "fetch it yourself, ask only as a last resort." Three unit tests prove the rewrite happens, doesn't double-apply, and that freshly-created sections carry the new wording.
