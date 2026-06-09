# ELI16 — Why sessions got interrupted "out of nowhere"

## The problem

You saw sessions suddenly stop mid-command — a build or test or script just
halting with *"Interrupted · What should Claude do instead?"* — for no obvious
reason. It wasn't random. Here's what was actually happening.

I run a safety watchdog that watches the shell commands running inside each
session. Its job is to rescue a session if a command gets truly stuck (hangs
forever). The way it works:

1. If a command has been running more than **3 minutes**, the watchdog gets
   suspicious.
2. Lots of legitimate commands take longer than 3 minutes — installs, builds,
   big test suites. So before doing anything, the watchdog asks an AI helper:
   *"Is this command actually stuck, or is it just a normal long-running job?"*
3. If the AI says "stuck," the watchdog presses **Ctrl+C** to kill the command.
   That Ctrl+C is exactly the "Interrupted" you saw.

The bug was in step 2. When that AI helper **couldn't run** — because the
machine was busy, rate-limited, or its circuit breaker was tripped (which
happens *precisely* when lots of commands are slow) — the old code **assumed
the command was stuck and killed it anyway.** That's called "failing open." So
under load, the watchdog Ctrl+C'd basically every command that ran longer than
3 minutes — including perfectly healthy builds and test suites and the
docs-coverage check in your screenshot.

In other words: the safety net meant to rescue stuck sessions was itself
interrupting healthy ones, and worst exactly when the system was busiest.

## What already exists

- The watchdog, its 3-minute threshold, and the AI "stuck or legitimate?" check.
- A separate, already-correct rule for pipeline commands (`tail`, `grep`): those
  already refused to be killed without a positive AI confirmation. This fix
  brings the *normal* command path in line with that safer behavior.

## What's new

One change in judgment: when the AI helper can't run, the watchdog now does the
**safe** thing instead of the destructive thing. It **does not interrupt** a
command just because it can't confirm it's stuck. It only force-stops a command
once it has been running past a deterministic **hard ceiling** — 30 minutes by
default — which is long enough that a genuinely frozen command (like one waiting
forever for keyboard input that will never come) still gets cleaned up, without
needing the AI at all.

There's a new dial, `monitoring.watchdog.hardCeilingSec`, default 1800 (30 min).
Set it to `0` to turn the ceiling off entirely — then the watchdog will *never*
interrupt a command unless the AI helper positively says "stuck."

## The safeguards in plain terms

- **Safe direction by default.** Killing a real build/test is frequent and
  costly; letting a maybe-stuck command keep running for a while is rare and
  cheap. When unsure, the watchdog now leaves the command alone.
- **Genuinely stuck commands are still rescued.** The 30-minute hard ceiling is
  a deterministic backstop that needs no AI — so a command frozen on input
  (e.g. `crontab -` waiting on stdin) is still caught.
- **Nothing else changes.** When the AI helper *can* run, its "legitimate" or
  "stuck" verdict is honored exactly as before. The change only affects the case
  where it can't run.
- **This change can only kill LESS, never more** — so it can't introduce a new
  way to interrupt healthy work.

## What you need to decide

Nothing required — it ships as a normal patch with a safe default. The only
optional choice is whether to tune `hardCeilingSec` (lower it if you want hung
commands recovered faster, or set `0` to never interrupt without a positive AI
"stuck" verdict). After it deploys, your sessions stop getting Ctrl+C'd out of
nowhere when the machine is under load.
