# ELI16: Session Boot Self-Knowledge (stop the agent re-asking for secrets it already has)

## The problem, in one story

You give your agent a GitHub token. It says "saved securely!" — and it really did save it, in an encrypted vault on disk. Then the conversation ends, a new session starts tomorrow, and the agent asks you for the token *again*. You send it again. It says "saved securely!" again. By the third time you're rightly asking: "why don't you remember this?"

Here's the trick: the agent never forgot the token — the vault is right there on disk. What the agent doesn't have is *any awareness that the vault has something in it*. Every new session wakes up like a person with a safe in their basement and no memory of owning a safe. So it does the natural thing: it asks you.

The same shape of failure hit a second place. The agent has a logged-in Telegram browser seat it uses for end-to-end testing (acting as the user in a real Telegram client). Sessions have used it dozens of times — but it lives at a *default* location that no config file names. So a new session asked the operator "what's the path?" for a thing the agent itself has used every day. Same disease: the knowledge exists, but nothing tells a new session about it at the moment it wakes up.

## The fix

When a session starts, a small hook already runs and injects useful context (your preferences, your org's rules). This change adds one more piece to that boot context — a short, auto-generated "what I already have" block:

- **The NAMES of the secrets in the vault** — like `github_token` — with one rule attached: *if a secret is named here, it's in the vault; read it from there, never ask the user to re-send it.* Just the names. Never the values. (The agent that owns the vault can already read its own vault — this block just tells it the vault is worth opening.)
- **Operational facts** the agent or operator has declared in config — like "your logged-in Telegram test seat is the default playwright profile at this path, on this machine." These are plain text lines in the agent's config file, so ANY instar agent on ANY machine can carry its own facts. Nothing about Echo or this laptop is baked into the code.

There's also one honesty rule learned from a real incident: if the vault file exists but can't be unlocked (a key mix-up — this actually happened), the block says exactly that — "vault exists but won't decrypt, investigate" — instead of pretending the vault is empty. An agent that thinks its vault is empty asks the user to re-send everything; an agent that knows the lock is jammed goes and fixes the lock.

## Does it survive long sessions, and does it scale?

Two fair worries, answered structurally. **Long sessions:** context gets compressed ("compaction") in days-long sessions, and anything injected only at the start can silently vanish. So the block doesn't just inject at boot — it RE-injects after every compaction, fresher than the original (a secret stored on day 2 shows up in the day-2 context). **Scale:** the block is a hard-capped ~2KB index — names and pointers, never contents — so a growing vault doesn't grow the boot cost; past the cap you get a "here's how to see the full list" marker instead of more bytes.

## Safety, in plain terms

- **No secret values ever appear** — the code only reads key names, and the tests include an explicit "the real value must NOT appear anywhere in the output" check.
- It's **read-only**: it doesn't gate, block, or filter anything. If the server is down or the feature is off, the hook injects nothing and the session starts normally.
- **Off switch:** one config flag (`selfKnowledge.sessionContext.enabled: false`) turns it off.
- **Tests can't touch your real keychain anymore**: a structural guard makes every test use a throwaway file key. (A test once silently overwrote the machine's real master key — that class of accident is now impossible.)

## Who gets it, and when

Every instar agent gets the machinery automatically on its next update (the boot hook is one of the files updates always refresh). The real question the review surfaced is whether the feature starts ON everywhere or dark-on-the-fleet:

- **Ship live fleet-wide (recommended):** this is a *fix to something you experience* — every agent of yours re-asks for credentials it already holds. Your own in-flight standard ("User-Facing Fixes Ship Live", PR #800 — earned from you catching exactly this mistake on the update-noise fix) says a UX fix shipped dark is invisible on precisely the agents whose behavior was reported. Worst case of this feature failing is the old behavior (the hook injects nothing); there's a per-agent off switch; and every serve is logged.
- **The cautious fallback:** dark on the fleet, live on Echo only, promoted after a bake — the pattern used for riskier new capabilities. The one real cost of going live everywhere: secret *names* (never values) start appearing in session transcripts on all your agents' machines. Same machine, same user account that already holds the vault — but it's the headline tradeoff, so it's your call, stated plainly.

The review rounds also hardened the details: names and facts are sanitized so a malicious key name can't smuggle instructions into the boot context; a flooded vault can't push important names out of view without leaving a "here's how to see the full list" marker; the "never re-ask" rule got an honest exception (re-ask if the stored secret is actually invalid); facts are labeled as unverified hints that safety rules always outrank; facts are added/removed with one API call instead of hand-editing a config file; and a decrypt-failure says "vault exists but won't unlock — don't touch it, tell the operator" instead of pretending the vault is empty.

## What you're deciding

1. Approve building the vault-names + operational-facts boot block as described.
2. Pick the rollout: **live fleet-wide (recommended)** or dark-fleet/live-Echo. One config line either way — the spec ships whichever you choose.
