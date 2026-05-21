# What this PR does — in plain English

## The story so far

A few releases back I added a "Which AI runtime?" prompt to `npx
instar` so a fresh user could pick Claude Code or Codex CLI as the
agent's runtime. Yesterday's first real test of the Codex path failed
on a model error, which I fixed in v1.2.11. The model fix worked —
Codex now spawned with the right model.

But the very next test showed an even uglier problem: when Codex
spawned with the wizard skill, it ignored everything the skill said
about being conversational. Instead of walking the user through
identity, autonomy, personality, and messaging — the whole point of
the wizard — Codex saw the skill as a task description and just
**executed the setup**. Ran `npx instar init` itself. Made up the
user's name from shell context. Started the server. Installed
autostart. The user watched a stream of shell commands and ended up
with a generic agent they never got to shape.

## The root cause

Claude follows behavioral instructions like "speak conversationally"
and "wait for the user". Codex's training pulls toward execution —
when given the same skill, it does the work instead of leading a
conversation. This isn't a bug we can fix by tweaking the skill text;
adding more "PAUSE HERE" markers doesn't reliably change Codex's
behavior.

## The fix

The wizard always runs on Claude now. The agent the user is setting
up can still be a Codex agent — that hasn't changed. But the
onboarding wizard itself, the one that asks "what's your agent's
name" and "how autonomous should it be", always uses Claude. Same
goes for the smaller wizard that helps you set up a secret store
(Bitwarden, 1Password) at the start of setup.

Both Claude and Codex are already required prerequisites today, so
no new dependency. The wizard runs on Claude; the resulting agent
runs on whatever the user picked.

## Why this works long-term

It's a separation of concerns: Claude is good at conversational
onboarding (and the skills were written for it). Codex is good at
execution (and that's what the agent does after setup). Each tool
gets the job it's good at. The runtime prompt during install still
matters — it determines which framework the AGENT runs on. But the
SETUP wizard is its own thing, and it picks the best tool for its
job every time.

## The test

A canary in the unit suite refuses any future PR that re-introduces
a Codex spawn for the wizard or the secret-setup micro-session. If
someone later tries to "give Codex another chance" by re-wiring the
spawn, CI catches it before users do.

## What it doesn't change

- The runtime prompt during install: still asks the user.
- The agent's actual runtime: still whatever the user picks.
- The Claude path: unchanged.
- The CLI surface: unchanged.

The only thing different is that the wizard's tool is no longer a
function of the user's runtime choice. The wizard always uses
Claude. The agent uses whatever you wanted.
