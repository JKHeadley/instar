# The two-machine test rig — what it is and why it matters (plain English)

## What this is

A permanent test rig that runs **two simulated machines inside one test run** — each with its own real ownership records, real replication between them (the same signed message path production uses, not a fake), and a real HTTP server with real authentication. On top of the rig sit the tests that drive the duplicate-conversation healer across both machines and prove, on every future code change, that:

1. When the same conversation is live on two machines, the healer on the lead machine works out the rightful owner, fixes the records, and — this is the part that needs two machines — the OTHER machine's own records visibly agree before anything gets closed. The proof reads the other machine's answer over real HTTP with real auth, never by peeking at its files.
2. When replication is delayed (the other machine hasn't heard the news yet), the healer escalates honestly after a bounded wait — exactly once, no spam — and then completes the heal by itself when the news finally arrives.

## Why it exists

The approved duplicate-session spec staged its rollout deliberately: stage 1 (already merged) only OBSERVES; stage 2 turns enforcement on for the development machines — but only once this rig is green in CI. That's the spec's own entry condition: "the two-node replication harness green in CI." This change makes that condition a real, checkable thing instead of a sentence in a document.

It already paid for itself before shipping: driving the July-10 incident through the rig exposed that the healer would have paged the operator instead of self-healing in the incident's own shape (records already correct, only the sessions duplicated) — because every earlier test faked the one step the rig runs for real. That bug was fixed and proven healed on this rig before the stage-1 merge.

## What it does NOT do

- It flips **nothing**. No feature turns on. All four rollout switches stay exactly where stage 1 left them (dark / observe-only), and the other features stage 2 depends on (the durable message queue, the machine-takeover engine) keep their own rollout schedules untouched.
- It is tests and test-support only — zero production code changes, zero behavior changes for any agent.
- The scenarios stage 2b and later need (promise hand-off between machines, the terminate-time safety probe) are present as **visibly pending** entries — they show up in every test run as "todo" with the spec section that owns them, so they can't be quietly forgotten, and they can't falsely show green.

## What you'd be agreeing to

Nothing new — this implements a deliverable the already-approved spec names. It makes stage 2's entry gate objective: when someone asks "can enforcement turn on yet?", the answer starts with "is the two-node rig green in CI?" instead of anyone's recollection.
