# ELI16 — Multi-Machine Bootstrap Robustness + Cross-Machine Live Test

## What I tried tonight, and what broke

I wanted to actually run the cross-machine seamlessness feature end-to-end
on two machines (your laptop + the mini) and prove it works. The
seamlessness code itself — the lease that decides "who's awake," the
live-tail that keeps the standby caught up, the handoff conductor, the
exactly-once delivery guard — all of it landed on main today in PR #428
and is verified-active on both machines (I can see "Fenced lease active /
Handoff ack/yield wire active / Live-tail receiver active" in both
machines' boot logs).

But getting two fresh agents paired into a mesh — the BOOTSTRAP — hit
four separate failures, each genuine:

1. **The npm package is broken.** When I tried to install `instar` from
   npm on either machine, the package was missing all of its compiled
   code. Anyone trying to install instar from scratch right now fails.
   I worked around it by copying the source code over by hand. That's
   not OK for normal users.

2. **The join command leaked your GitHub token.** When I ran the mesh
   `join` command on the mini, it failed on an internal step and the
   error message printed your full GitHub access token to the screen. I
   asked you to revoke it. Bug: error messages must scrub credentials
   first.

3. **The init and join commands fight over the same name.** Setting up a
   new agent with `instar init <name>` creates a system service that
   keeps trying to restart the agent at one location. A subsequent
   `instar join` puts the agent at a DIFFERENT location. The system
   service keeps fighting the join's process for the port and the
   identity. Operator has to manually kill the old service.

4. **The mesh git substrate doesn't auto-reconcile.** The two machines
   share state through a git repo (each commits its updates and pulls
   the other's). If both commit at the same time, one's push is
   rejected, the loser's pull fails because of unrelated local file
   changes, and the two machines silently disagree about who's awake
   and which machines are in the mesh. There's no auto-merge.

None of these are bugs in the seamlessness feature itself. They're bugs
in the surrounding setup-and-sync glue that the feature depends on.

## What this spec is

A single comprehensive spec that fixes all four bootstrap gaps, builds
the one-button test harness (Part 2.1 of the self-propagation spec you
already approved), runs the actual cross-machine live test, and flips
the exactly-once delivery flag to default-on once the test passes.

Seven tracks, each its own PR, each three-tier-tested, each
migration-parity-compliant. Roughly 6–8 hours of autonomous execution
in one overnight run.

## What you get when it's done

- A fresh user can install instar from npm and it works (Track A).
- Tokens never leak in URL log lines (Track B).
- `instar init` + `instar join` produce one clean running agent, no
  manual cleanup (Track C).
- Two machines auto-converge their mesh state even when they commit at
  the same time (Track D).
- One command — `instar test-as-self` — runs the full deploy + verify
  loop for a throwaway agent (Track F).
- The cross-machine seamlessness feature is proved end-to-end on real
  hardware, with the handoff, the live-tail catch-up, and the
  exactly-once-redelivery scenarios all verified (Track E).
- The exactly-once delivery flag goes from default-off to default-on
  for everyone (Final).

## What I need from you

- Approval of this spec as a single autonomous run.
- (At one point during the run) two test bot tokens via Secret Drop —
  not required at start, just at the live-test step. I'll ping when I
  get there.
- Revoke the GitHub token from tonight's leak (~30 seconds in github
  settings).

## What I will NOT do without asking

- Touch Bob (the mini's existing protected agent). All test agents are
  throwaways named `mmtest2`.
- Touch Echo (this workstation's main agent). Test agents run in
  isolated agent homes on isolated ports.
- Deviate from the spec without surfacing a single Telegram message
  with the choice + my recommendation.

## How long this will take

About 6–8 hours of autonomous work. The four bootstrap tracks
(A/B/C/D) are independent so I'll run them in parallel and they'll
land roughly at the same time, bounded by the slowest. Then the
harness, then the live test, then the flag-flip. I'll report at real
milestones (each PR merged + the live test result), not per-step.

## How I'll know it's done

The autonomous skill's stop hook unblocks only when:
- All seven tracks are merged to main with CI green
- The live test's JSON verdict report shows all 7 procedure steps PASS
- The exactly-once flag-flip PR is merged
- A summary report is in your Telegram
- The lessons learned are written to my durable memory so this exact
  bootstrap pain can't recur

If any of those isn't true when I think I'm done, the hook keeps me
working.
