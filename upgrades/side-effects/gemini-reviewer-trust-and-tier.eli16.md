# The Gemini spec reviewer says why it failed — Plain-English Overview

> The one-line version: the Gemini reviewer was failing on every run and only ever said "error"; now it gets past the folder-trust refusal and names the real reason it still fails.

## The problem in one breath

When Instar reviews a spec, it asks outside models (GPT through codex, Gemini through the gemini CLI) for a second opinion. The Gemini reviewer had failed every single time, and each failure was recorded as a plain "error" with no findings. Two things were actually going on. Newer versions of the gemini CLI refuse to run in a folder you have not marked as trusted, and the reviewer runs it from a neutral scratch folder. And once that is out of the way, Google refuses the login itself: the free "Gemini Code Assist for individuals" tier no longer supports this client.

## What already exists

- **The cross-model reviewer** — sends the spec to each installed outside model and folds the replies into the review. When a call fails it records a "degraded" result with a short reason.
- **A shared failure classifier** — turns an error message into reasons like "timeout" or "rate-limited", and "error" when it recognises nothing. Neither Gemini failure was recognised.

## What this adds

The Gemini reviewer now passes `--skip-trust`, the gemini CLI's own flag for "trust this folder for this one run". It is switched on only for the reviewer's call, not for anything else in Instar that uses gemini, and it changes no global setting. The two Gemini failures now get their own names: `gemini-untrusted-folder` for the trust refusal and `gemini-tier-unsupported` for the account cut-off. Everything else is classified as before.

One extra safeguard: older gemini versions (we checked 0.35.0) do not know the flag and refuse to start when they see it. Those versions also do not have the trust check, so if the CLI says it does not know the flag, the call is retried once without it.

## The safeguards

**Nothing new can block.** These are labels on a result that was already marked degraded. How the spec-level review flag is computed is untouched.

**Other gemini users are unaffected.** Without the opt-in, the exact old command line is used; a test pins this.

**Old CLIs do not regress.** The one-time retry without the flag keeps them working as they did.

## What this does not fix

On this machine Gemini will still fail, because the account's tier is cut off. The difference is that the record now says `gemini-tier-unsupported` instead of `error`. Fixing that needs a decision about which Gemini account or auth method to use, which is an operator choice and is tracked separately.

## What you actually need to decide

Nothing for this change. It is safe to merge on green CI; the open question is the separate one about Gemini auth.
