# Codex enrollment uses `--device-auth` — Plain-English Overview

> The one-line version: Codex account enrollment was running `codex login` (which needs a local browser and dies on a headless machine); it now runs `codex login --device-auth` (which prints a code that works from anywhere), so the fleet's Codex "Set up" cells can actually enroll.

## The problem in one breath

When an agent runs on more than one machine, it can enroll a Codex (ChatGPT) account onto a *remote* machine — the Mac Mini, a laptop — so that machine can use that account too. The enrollment kicks off a sign-in on the target machine and expects it to print a short code + URL to approve. But the command it ran, plain `codex login`, doesn't print a code — it tries to pop open a web browser on that machine and wait for a local redirect. On a headless machine that has no usable browser, nothing completes, no code is ever printed, and the whole enrollment dies with the error `login-did-not-start`. Every Codex "Set up" button on the Mini and laptop was stuck for exactly this reason.

## What already exists

- **The enrollment wizard** — starts a framework's sign-in, scrapes the public verification URL + one-time code out of the terminal, and hands it to the operator to approve. Never touches a token, only the public code.
- **Flow "kinds"** — the wizard already knew Codex/OpenAI (and grok/xAI) should use the single-code *device-code* flow, especially for a remote machine (`EnrollmentWizard.remoteKind('openai')` returns `device-code`). That decision was already correct.
- **grok-build** — the newest framework — already enrolled with `grok login --device-auth`, the correct device-code command. So the pattern was proven; Codex was simply never updated to match.
- **An operator override** — `subscriptionPool.enrollment.loginCommands` lets a machine override the per-framework login command in its config. (This is how the dev machine had already been hand-patched — but the *default* was still wrong for every other machine.)

## What this adds

One character of real behavior change and a small refactor around it. The default Codex enrollment command becomes `codex login --device-auth` instead of `codex login`. That makes the command match the flow-kind the wizard already expected: a device-code sign-in that prints a portable URL + code, which works identically whether the machine has a browser or not.

The supporting refactor: the per-framework command map (`DEFAULT_ENROLL_LOGIN_COMMANDS`) moved from a buried local variable inside server startup to an exported constant in `FrameworkLoginDriver.ts`, next to the other enrollment helpers. That's purely so a unit test can lock the invariant in place.

## The new pieces

- **`DEFAULT_ENROLL_LOGIN_COMMANDS` (now exported)** — the single source of truth for "which command each framework runs to sign in." It is data, not logic; it decides nothing at runtime beyond what string gets spawned. The operator override still merges on top of it unchanged.

## The safeguards

- **A regression test** now asserts that Codex enrolls with `--device-auth`, that every device-code-kind framework (Codex, grok) carries the flag, and that the URL-code-paste frameworks (Claude) deliberately do *not*. If someone ever reverts Codex to plain `codex login`, the test goes red. This is "the command must match the kind" enforced in code instead of memory.
- **No token ever moves.** `--device-auth`, like the existing grok flow, produces only a public verification URL + one-time code — never a credential.
- **The operator override is untouched.** A machine that already set `subscriptionPool.enrollment.loginCommands["codex-cli"]` keeps its value; this only fixes the default that everyone else falls back to.
- **Local enrollment still works.** `codex login --device-auth` completes fine on a machine that *does* have a browser too — it's strictly more portable, not a trade-off.

## What the reader needs to decide

Nothing structural — this is a one-line bug fix that brings Codex in line with the flow-kind the system already chose and with how grok already behaves. The only judgment call is confirming that always using the device-code flow for Codex enrollment (rather than the browser-callback flow even on a machine that could do it) is acceptable. It is: the device-code flow is the phone-approvable, machine-independent path, and it is what the wizard already declared it wanted.
