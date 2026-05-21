# Hardened Secret Drop Retrieval — Plain-English Overview

> The one-line version: every place in instar that told an agent how to fetch a submitted password was teaching the leaky way, and now they all teach the safe way.

## The problem in one breath

When a user types a password into a Secret Drop form, the agent needs to read that password to use it (run an unlock, set a GitHub secret, etc.). Until now, every documented retrieval path told the agent to use a plain `curl` request — but `curl` prints the whole response, including the password, to the terminal. The terminal output is what Claude Code records in its session transcript and what gets sent back to Anthropic on the next turn. So the moment the agent ran the documented command, the password was in the conversation history, the session log, and the API context — exactly the things Secret Drop was supposed to bypass.

## What already exists

- **Secret Drop itself.** The web form, the one-time link, the in-memory store, the 5-minute cleanup timer, the route that returns the submitted values. All of this works correctly.
- **A hardened retrieve script.** Written by one agent after the 2026-05-20 incident, lives at `.instar/scripts/secret-drop-retrieve.mjs` on that one machine. It prints the field value to stdout in a way that pipes cleanly into other commands but never prints the rest of the response, so the password cannot accidentally land in a log.
- **PR #290 (the previous follow-up).** Surfaced Secret Drop in `/capabilities` and added a one-line hint that pointed at the hardened script, but didn't give the actual command and didn't ship the script itself anywhere except the single machine that wrote it.

## What this adds

The hardened script becomes a first-class template that ships with every instar install. New agents get it on first `init`; existing agents get it the next time they run `instar update`. Every line of agent-facing guidance that previously taught the leaky `curl` pattern — the CLAUDE.md template, the spawn message the server injects when a Secret Drop arrives, the retry message when a submission goes unclaimed, the `/capabilities` hint — is rewritten to teach the hardened command instead. A migration patches existing agents' CLAUDE.md files in place, so even installs that were updated months ago will get the safer guidance on the next update.

The agent-facing command form becomes:

```
node .instar/scripts/secret-drop-retrieve.mjs TOKEN field-name
```

For discovering what fields are available:

```
node .instar/scripts/secret-drop-retrieve.mjs TOKEN --names
```

For one-shot destructive read (the original behavior, now opt-in):

```
node .instar/scripts/secret-drop-retrieve.mjs TOKEN field-name --consume
```

## The new pieces

- **`src/templates/scripts/secret-drop-retrieve.mjs`** — the hardened helper, now part of every instar install. Streams the field value to stdout via `process.stdout.write` (no newline, no rest-of-body), prints field names to stderr in `--names` mode, refuses to print the response body in any error path.
- **`installSecretDropRetrieve` in `init.ts`** — the install hook called from three places mirroring how `installSerendipityCapture` is wired. Places the script under `.instar/scripts/` (framework-neutral, survives Claude-code reinstalls).
- **`migrateScripts` block in `PostUpdateMigrator`** — always-overwrite the script on every update. Same pattern as `convergence-check.sh`. Idempotent.
- **`migrateClaudeMd` block** — detects the legacy `curl /secrets/retrieve/TOKEN` line and rewrites it to the hardened guidance. Port-tolerant (matches any local port literal). Idempotent (already-hardened CLAUDE.md is skipped).

## The safeguards

**Prevents the documented path from being unsafe.** Every surface that teaches retrieval now teaches the hardened command. There is no documented path that leaks the response body. An agent that copies the documented command verbatim runs the safe one.

**Prevents update-in-place agents from being left behind.** The migrator runs on every `instar update`. The script install is always-overwrite (security-critical → fresh content every time). The CLAUDE.md rewrite is port-tolerant so agents installed when the local port was 4040 get the same rewrite as agents installed when the local port was 4042. The idempotency check on the CLAUDE.md rewrite means double-runs don't double-write.

**Prevents the new helper from accidentally printing the body.** The script uses `process.stdout.write(v)` for the value, never `console.log(body)`. The error path explicitly states "don't fall back to printing raw response body — that's the leak we're explicitly hardening against." The `--names` mode prints only field names + lengths to stderr; stdout stays empty. The default mode is peek (non-destructive), so an agent that botches the first attempt can retry without losing the submission.

## What ships when

One PR. The six surfaces ship together because they reference each other — patching one and leaving the others would leave an agent reading mixed guidance.

## What you actually need to decide

This PR closes failure #2 from the 2026-05-21 case study (the workaround-reflex / unsafe retrieve pattern). Failure #1 was closed by PR #290; failure #3 (introspecting `/capabilities` from `FeatureRegistry`) is the next follow-up. Ready to ship — anything else you want on this PR before merge?
