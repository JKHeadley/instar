# Mentor Stage-A Full Exchange Surface — Plain-English Overview

The mentor system has two hats. Stage A acts like a normal user checking in with an AI developer. It should see only what a real user would see: the conversation and the visible task status. Stage B can do deeper forensics later, but Stage A stays intentionally blind to internals.

The current Stage-A surface is missing half of the conversation. It includes the mentee's replies, because those are recorded in the mentor reply log. It also includes the mentor's onboarding agenda, because that agenda is the mentor's own plan. But it does not include what the mentor already asked the mentee, because the sent prompt content is not logged anywhere. The existing a2a sent ledger is metadata-only, so Stage A can infer progress from replies but cannot see the mentor-side questions that produced those replies.

That matters for agenda rotation. If the mentor says, "Next, verify Secret Drop," and the mentee later says, "Done," the next Stage-A turn should see both sides: the assignment and the reply. If it only sees "Done," it may guess incorrectly about which agenda item was completed, repeat a task, or skip ahead without enough context.

This change records mentor-sent prompt content in a small append-only JSONL file in the agent state directory. Each row carries a timestamp, correlation id, destination agent, topic id when present, and the message text. The log is written only after the send succeeds, so it represents prompts that actually left the mentor.

The pure Stage-A surface builder then reads two already-parsed inputs: mentor-sent rows and mentee-reply rows. It sorts both by timestamp and renders them as a normal visible exchange:

Mentor: Please verify Secret Drop end to end.
Mentee: Done, I verified it and reported the result.
Mentor: Next, try a tiny source PR.

The parser for the new sent log is defensive in the same style as the existing reply parser. Bad JSON, missing timestamps, empty messages, and rows for other mentees are ignored. The pure surface builder remains free of file I/O, which keeps the Stage-A boundary testable and prevents hidden internals from creeping in.

What does not change: Stage B forensics, a2a transport, scheduling, spend policy, safe-window logic, and mentee reply capture all stay as they are. This is a narrow fix to make the visible Stage-A conversation complete.
