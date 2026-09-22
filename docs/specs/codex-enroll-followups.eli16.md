# Codex enrollment: three follow-up fixes — Plain-English Overview

> The one-line version: setting up a Codex account on another machine failed for two more reasons — the account's settings folder was never created, and the check that confirms "is this really the right account?" was asking a reader that cannot read Codex accounts — and separately, the release check called good releases failures because it gave up waiting too early.

## The problem in one breath

After the earlier fix that made Codex sign-in print a code instead of trying to open a browser, setting a Codex account up on the Mac Mini or the laptop still failed every single time, with a message saying the sign-in never started. It had in fact started; two different things were broken behind it. Separately, the step that checks a freshly published release kept marking perfectly good releases as failed, which trains everyone to ignore a red release.

## What already exists

- **First-time account setup across machines** — the agent can put one of your accounts onto another machine, signing in there without you typing anything.
- **The code-based sign-in** — Codex prints a short code and a link; the agent approves it using the stored passkey.
- **The identity check** — before an account is registered for use, the system confirms the credential that just arrived really belongs to the account you approved. There are two readers behind this: one that understands Claude credentials, and a combined one that also understands Codex.
- **The post-release check** — after publishing, a step waits for the new version to appear and then tests it.

## What this adds

Three small corrections, each with a plain cause.

- **Create the settings folder first.** Each account's sign-in runs with its own private settings folder. For a brand-new account that folder doesn't exist yet, and Codex quits instantly when it's missing. The sign-in therefore died in under a second, and the watcher then stared at a dead window for three minutes and blamed a timeout. Now the folder is created before the sign-in starts. This is done in the one place every setup path goes through, so they all benefit.
- **Ask the reader that can actually read Codex.** The setup was handed the Claude-only reader. Given a Codex account it can only answer "I don't know", so the identity check saw no account name and refused to register — permanently, no matter how many times it was retried. It now uses the combined reader, which was built for exactly this and simply never got connected here.
- **Stop calling good releases failures.** The post-release check waited three minutes for the new version to appear. A release this size can take longer — one recent version showed up about four minutes after publishing, so the check failed a release that had worked perfectly. It now waits fifteen minutes.

## The safeguards

- **The identity check still refuses anything it cannot verify.** This change does not weaken it or skip it; it gives it a reader that can answer the question. An account whose name cannot be confirmed is still held for your review.
- **Nothing new is trusted.** No token is read, logged or moved. The folder is created with owner-only permissions.
- **Waiting longer only costs time.** If a release genuinely never appears, the check still fails — just later. The previous setting produced false alarms on healthy releases, which is the more expensive failure because it teaches people to ignore the signal.

## How we know

All three were confirmed on live machines, not reasoned about. With the folder missing, the sign-in window died instantly; with it created first, the same command printed the code. With the Claude-only reader the account was refused even though the stored credential was correct and Codex reported being logged in; with the combined reader the same account registered immediately. Three accounts on the Mac Mini went from stuck to signed-in and active this way.
