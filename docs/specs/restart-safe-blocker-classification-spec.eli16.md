# Plain-English overview: label which sessions are "safe to restart through"

## The situation

When the agent wants to install a new version, it has to restart its server. But
if someone (or the agent itself) is in the middle of a live session, the agent
politely waits instead of yanking the rug — it *defers* the restart. The
downside: a session can keep the agent on old code for a long time, because the
restart keeps waiting.

Not every busy session is equal, though. Some sessions resume perfectly fine
after a restart — the autonomous loop, for example, just re-reads its goal file
and picks up where it left off (this is called CONTINUATION). Restarting through
one of those costs basically nothing. Other sessions — a person typing in the
middle of real work — genuinely shouldn't be interrupted.

Right now the agent can't tell those two kinds apart. So there's no foundation
for a smarter rule like "go ahead and restart through the ones that resume
cleanly."

## What this change does

It adds a **label**, nothing more. When the agent is deferring a restart, it now
sorts the blocking sessions into two buckets:

- **restart-safe** — its topic resumes cleanly across a restart (it has a
  per-topic autonomous state file, so it comes back via CONTINUATION).
- **hard blocker** — no known clean-resume path; leave it alone.

Both buckets show up in the status readout you can fetch (`GET /updates/status`),
next to the existing restart info.

## What this change does NOT do

It does **not** change when the agent restarts. Even if *every* blocker is
restart-safe, the agent still waits exactly like it does today. This is on
purpose: this is step 1, "establish the label." Acting on the label (actually
restarting through the safe ones, carrying their state across) is a later,
separate step that a human will sign off on first.

## Where it came from

The codex agent (Codey) suggested this during a mentorship session — it spotted
that "restart stuck behind active sessions" is the root reason updates lag, and
proposed labelling sessions as restart-safe as the right first slice. This PR
builds exactly the slice Codey scoped.

## What already exists

- The restart-deferral machinery (UpdateGate) already exists and already lists
  the blocking sessions.
- The "always restart now" developer switch (`restartImmediately`, #641) already
  exists — but it just skips deferral entirely for one agent. This is the more
  general, safer idea: keep deferring, but know *which* sessions could be safely
  restarted through.
- Autonomous sessions already resume via CONTINUATION; this just reads whether a
  topic has that autonomous state file.

## What's new

- Two read-only fields in the update status: `restartSafeSessions` and
  `hardBlockingSessions`.
- A pluggable "is this session restart-safe?" check inside the gate (off unless
  wired; the agent wires it to the autonomous-state-file check).

## What you need to decide

Nothing to operate it — it's read-only labelling. The real decision is later:
whether to let the agent actually restart through restart-safe sessions. That
step is deferred and will come back for explicit approval. Because this is a new
capability (not a bug fix), the PR is opened for review rather than
auto-merged.

## How to verify it after deploy

Fetch `GET /updates/status` while a restart is being deferred: you'll see the
blockers split into `restartSafeSessions` and `hardBlockingSessions`. When
nothing is deferring, both are empty. The agent restarts on exactly the same
schedule as before — the label is informational only.
