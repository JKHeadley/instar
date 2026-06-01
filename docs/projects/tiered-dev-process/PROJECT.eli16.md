# Plain-English overview: match the paperwork to the size of the job

## The problem we're fixing

Right now, every single code change the agent makes has to come with a full formal
spec that you approve before it's even built — no matter how small. Fixing a typo or
adding one read-only status field needs the same heavyweight paperwork as building a
whole new subsystem. That's backwards: it wastes effort on tiny changes, and it makes
the spec feel like a rubber stamp instead of a real design review for the changes that
actually need one.

There's a second, related problem. Part of reviewing a spec is getting a "second
opinion" from a *different* AI model (a non-Claude model like GPT) — that's the
"cross-model review." Today that runs by calling an outside API, which needs API keys
and isn't reliably available to every agent. We want to fix that too.

## What we're going to do

**1. Three tiers of formality, matched to the size and risk of the change:**

- **Tier 1 — small/mid:** the agent just builds it and opens a pull request with a
  plain-English overview. You read the PR and merge it. No pre-approved spec.
- **Tier 2 — larger:** a full spec with an overview, reviewed (including the second-AI
  opinion), and you approve it *before* it's built. (This is today's process.)
- **Tier 3 — a whole project:** we design and approve the big picture first (this very
  document is an example), then each piece of the project becomes its own Tier-2 spec
  you approve as we go.

The rule across all three: **anything you have to review — a PR or a spec — comes with
a plain-English (ELI16) overview.** That part doesn't change.

**2. The agent doesn't get to decide the tier — the system does.** A change's tier is
computed automatically from how big it is *and* how risky it is. A one-line change is
usually Tier 1 — UNLESS it's near something dangerous (the secret-handling code, the
auth/token code, the message-delivery path), in which case it's bumped up regardless of
size. The tool prints the tier and *why*, so it's never a judgment call you have to
trust me on.

**3. The "second-AI opinion" stops needing API keys.** Instead of calling an outside
API, the system detects whether the **codex** tool is installed on the machine (codex
just passed our full compatibility bar) and runs the GPT review *through codex*, using
the agent's existing codex login. So every agent that has codex gets the second opinion
for free, automatically, on all its work. If an agent has *no* such tool installed, it
doesn't get blocked from shipping — it just does the review with the internal reviewers
only and stamps the spec with a loud "no cross-model review available" note, so anyone
reading knows it didn't get the outside opinion. (You approved this fallback.)

## What already exists

- The commit gate, the spec process, the ELI16 requirement for specs, and the
  spec-review-convergence process (with internal + cross-model reviewers) all already
  exist. This project **re-shapes** them; it doesn't invent them from scratch.
- The cross-model reviewer is already a written prompt — we're changing *how it's run*
  (through codex instead of an API), not what it asks.
- Codex is already a supported framework (it just passed full parity), which is why it's
  the first tool we detect for reviews.

## What's new

- Two lighter paths (Tier 1 = PR + overview; Tier 3 = project-then-steps) alongside the
  existing heavy path (Tier 2 = spec).
- An automatic tier classifier baked into the gate.
- Cross-model review that runs on the installed codex tool instead of an API, with a
  safe fallback when no tool is present.

## What you need to decide

This document is the **whole-project design** for your approval. If the shape looks
right, I'll turn each of the four steps (the classifier + Tier-1 path; the codex-based
review; the skill/docs updates; making sure existing agents get the change) into its
own spec for your approval, and build them one at a time. There are four small open
questions at the end of the technical design — mainly: for Tier-1 PRs, do you want to
merge them yourself, or should I auto-merge a clearly-safe subset once tests pass?

## How we'll know it worked

A small change will move through as a quick PR + overview you merge in seconds; a big
change will still get the full spec + second-opinion review before it's built; and
every agent with codex will be getting cross-model reviews with no API keys — you'll see
the "reviewed via codex" note on converged specs instead of an API-based one.
