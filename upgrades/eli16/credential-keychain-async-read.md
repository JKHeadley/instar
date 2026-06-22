# Credential keychain read — async + timeout-bounded — ELI16

## What this is

Your agent's server has a single main thread that handles everything — answering the dashboard,
replying to messages, running every background check. If any one operation on that thread stops to
wait for something slow, *everything* waits. That's a "freeze."

This fixes a freeze. To know which account a credential belongs to, the server reads it from the
macOS keychain by running the `security` command — and it did that the BLOCKING way (`execFileSync`)
with no time limit. Normally a keychain read is instant. But you run several agents on one Mac, and
they all go through one macOS keychain service (`securityd`); when they pile up, each read can take
several seconds. The server checks all 5 of your Claude accounts one after another, so the freezes
added up to **4–13 seconds, roughly every 30–60 seconds**.

That's what was actually still breaking the dashboard. The earlier tmux fix (v1.3.643) correctly
removed the *tmux* version of this same problem, but there were TWO blocking calls, and this is the
second one. During each freeze the dashboard's live connection drops (you saw "Disconnected"), and
the freeze even looked to the agent like the laptop had gone to sleep, so it kept false-alarming a
"wake."

## What already exists

The agent already has the right pattern in a sibling file (`CredentialProvider.ts`) — it reads the
keychain with a 10-second time limit. This read path just never got that treatment. And the
credential-audit loop that triggers the reads is already `async`, so switching it to a non-blocking
read is clean.

## What's new

- The keychain read now has an **async, off-the-main-thread version** (`readAsync`) that the
  audit loop uses — so while one account's keychain read is in flight, the main thread is free to
  answer the dashboard, messages, and everything else. The freeze is gone, regardless of how slow
  `securityd` gets or how many accounts there are.
- Both the old synchronous read and write now also carry a **3-second time limit**, so even a
  caller that still reads synchronously can't wedge forever (it just falls back to "needs re-auth"
  and retries next cycle — exactly what it did before for a missing entry).
- It's backward-compatible: the new async method is optional, so nothing else has to change.

## What you need to decide

Nothing. It's a self-contained, low-risk fix on one read path, fully covered by tests. Once it ships
and your agent updates, the dashboard should stay connected under load instead of flapping, and the
spurious "wake" alarms stop.
