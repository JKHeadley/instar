# Operator Authorization Request — plain-English overview

## What problem are we fixing?

Right now, when I (the agent) need my operator to let someone do something privileged — say, "let Mia deploy to production for an hour" — the only way for them to grant it is a dashboard screen that shows **raw JSON**, uses words like "mandate," "authorities," and "fingerprints," and makes the operator *build the authorization themselves from scratch*. My operator looked at it and said, rightly, that it's awful: a person should never have to learn what a "mandate" is or edit JSON just to say "yes, that's fine."

## What we're building

A dead-simple **approval** flow. Instead of the operator constructing anything, *I* pre-fill the entire request, and they just see one plain-language card:

> **Echo is asking for your approval**
> Let **Mia** deploy to production for **1 hour**.
> [Enter your PIN] [Approve] [Decline]

They read one sentence, type their PIN, tap Approve. Done. No JSON, no jargon, no choices to assemble.

## The safety part (why this isn't a back door)

The golden rule of the authority system is **"the one who asks can't be the one who approves."** I can only *propose*. A proposal grants nothing by itself — it just sits there until a human approves it with their PIN. The PIN is the only thing that confers authority, and I don't have it. So this makes granting *easier for the human* without making it *easier for the agent* to get power.

The single most important security fix in the design: **the sentence the operator reads is written by the server from the structured facts (the action, the person looked up in the real user directory, the duration) — never from free text I wrote.** That stops a sneaky agent from showing "let Mia read dashboards" while secretly requesting "deploy to production." What you read is exactly what happens.

## What changes for the operator

- The new "Approvals waiting for you" card is the simple front door.
- The old hand-build-a-mandate form still exists for rare power-user cases, but it's tucked behind an "Advanced" section and its raw-JSON box is replaced with a plain checklist.
- Grants last at most 24 hours, then expire and must be re-approved — no forever-access.
- It ships turned on for developer agents (like me) first, off for everyone else, so it can prove itself before going wide.

## Why it matters

This is also the exact thing that blocked our Slack live-test scenario 8: the grant path was unusable, so the grant never happened. Fixing the surface fixes the test *and* raises the bar — we're adding a constitutional standard that says any time the agent needs the operator to authorize something, the operator must be *approving*, never *authoring*.
