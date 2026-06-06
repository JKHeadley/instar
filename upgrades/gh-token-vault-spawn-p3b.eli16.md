# ELI16 — The agent brings its own GitHub key

## The one-sentence version
When an agent starts a work session, it now slips its OWN GitHub key (from its
locked per-agent safe) into that session's pocket — instead of every agent on
the computer reaching for the one shared key hanging by the door.

## The backstory
This is the third installment of the "shared computer" security fix. A real
incident showed what goes wrong when several agents (working for different
people) share one machine: one agent ended up using a DIFFERENT person's
GitHub seat, because the GitHub command-line tool reads one machine-wide
login file (`~/.config/gh`) no matter who is asking. Earlier installments
locked down git *identity* (whose name goes on commits). This one starts on
git *credentials* (whose key opens the door).

The design the operator picked (option C): don't force everyone to re-log-in
with separate config folders — instead use the per-agent encrypted safe
(the SecretStore vault) that already exists, already holds secrets like
`github_token` for some agents, and already syncs between an agent's own
machines.

## What this change does
At the moment a session is spawned, the agent's vault is checked for a GitHub
token (`github_token`, or the nested `github.token`). If one is there, the
session's environment gets `GH_TOKEN=<that token>` — and the GitHub CLI
prefers `GH_TOKEN` over the machine-wide login file, so everything the
session does on GitHub happens as THIS agent. If the vault has no token,
nothing is added and the session behaves exactly as before.

Three careful details:

1. **No token, no change.** Installs that never set up a vault token keep
   today's behavior byte-for-byte. We prove this with a test that spawns
   without a vault and checks the environment has no GH_TOKEN at all.
2. **A broken safe can't break work.** If the vault can't be read (corrupted,
   wrong key, whatever), the spawn logs one warning and proceeds without the
   token. A test corrupts the vault on purpose and proves the session still
   starts.
3. **The hardened triage session is deliberately skipped.** That special spawn
   scrubs credentials from its environment by design — we don't hand it a
   GitHub key.

## Why it's safe
- The injection rides the exact same mechanism the system already uses to
  hand sessions their other credentials (the Anthropic key travels the same
  way) — no new transport invented.
- The resolver never throws and never runs a subprocess, so it can't wedge a
  spawn or trip the test suites that script subprocess call sequences.
- Reading the vault uses the dual-key fallback shipped earlier, so a vault
  written with a file key still opens even when the keychain is unavailable.

## A bonus fix that rode along
The existing spawn-reroute test suite secretly depended on the DEVELOPER'S
machine having free memory (the reroute gate genuinely refuses when the real
host is loaded). On a busy machine, 8 tests failed before this change touched
anything. The suite now pins the pressure reading to "normal," because those
tests assert reroute logic, not host health.

## What's deliberately left for next time
- **P3c**: the git credential helper side (plain `git push` over https still
  uses the machine keychain — `gh` operations are covered now, raw git isn't).
- Server-side `gh` calls (CI polling, repo lookups) still use the machine
  seat; they can adopt the same resolver later.
- An agent-awareness section once Phase 3 is complete, so agents know a vault
  `github_token` flows to their sessions automatically.
