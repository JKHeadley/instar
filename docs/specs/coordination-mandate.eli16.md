# ELI16 — The Coordination Mandate (the "permission slip" system)

## The problem in one sentence

Justin wants Echo and Dawn to finish the feedback migration **without him approving
every little step** — but an agent must never be able to give *itself* permission for
risky things, because "the one asking must not be the one authorizing" is the safety
rule that keeps agents honest.

## The idea

Instead of Justin clicking "approve" fifty times, he writes **one permission slip** up
front: *"Echo and Dawn may do these specific things, within these limits, until this
date — and I can tear it up at any time."* He's still the one in charge; he just sets
the rules once, ahead of time, instead of per-action. The slip — not the agent — is
what authorizes each action.

Seven things make the slip safe:

1. **The slip authorizes, never the agent.** Acting under the slip is executing
   Justin's written policy, not self-permission.
2. **Only Justin can write one.** A slip carries a proof that it came through his
   PIN-protected dashboard. An agent's normal API access *cannot* create or widen a
   slip — a forged or edited slip fails verification automatically.
3. **It lists exactly what's allowed.** Specific actions with specific limits (e.g.
   "swap a *read-only* credential for the *feedback-migration* only"). Anything not
   listed still needs Justin.
4. **Risky steps need a real-world green light.** A dangerous action can be tied to an
   objective check the agent can't fake (like "the parity monitor has been clean for an
   hour"). The agent's opinion is never the input — the measured state is.
5. **Justin can revoke it instantly.** Checked on every single action.
6. **It expires and names exactly two agents.** No drift to other agents or other work.
7. **Everything is written down.** Every allowed AND denied action lands in a
   tamper-evident log (each entry is chained to the previous one, so deleting or editing
   a line is detectable). Justin can audit everything after the fact.

## What Justin decided (his A / A / B picks, 2026-06-05)

- **The final "go-live" flip stays his click.** The slip covers everything *up to* the
  irreversible cutover — the agents prep and verify, a human flips the switch.
- **Slips are issued from his dashboard, behind his PIN.** Nothing new to learn, and an
  agent token alone is structurally unable to issue one.
- **The first slip covers only two powers:** swapping the read-only credential and
  signing off each other's code reviews. Cutover is not delegated at all yet.

## What was built (and what it refuses to do)

The enforcement engine: a signed slip store, a deny-by-default gate that checks every
action in a strict order (does the slip exist → is it genuinely Justin's → expired? →
revoked? → is this agent named on it? → is this action listed and inside its limits? →
does any required real-world check pass?), and the chained audit log. **With no slip
issued, the gate denies everything** — installing this changes nothing until Justin
issues the first slip. Auto-anything stays off; the gate never weakens an existing
safety check, it only adds a controlled way to delegate specific ones.
