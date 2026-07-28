# ELI16 — Warn the operator about Claude's two-code login

## The one-sentence version

When I start enrolling a new Claude subscription account, the pending-login card
now tells you up front that Claude will ask for TWO codes in a row — so the second
prompt doesn't catch you off guard.

## What problem is this fixing?

To enroll a new Claude account, I drive Claude's login and show you a sign-in link
plus (for some flows) a code. You open the link on your phone, approve, and you're
in. That's the happy path.

But for a **brand-new** Claude login, Anthropic adds a step: it first emails you an
**email-verification code**, and only after you enter that does it show you the
actual **sign-in code**. So you end up dealing with two different codes, one after
the other. During live testing (topic 20905) this was genuinely confusing — you got
a second code when you thought you were done, with nothing explaining why.

## What I actually changed

I taught the enrollment flow to attach a short heads-up to the pending login that
says, in plain words: "a brand-new Claude login often asks for two codes in order —
first the email-verification code, then the sign-in code; enter the email one
first." Three small parts:

1. The pending-login record can now carry an optional `notice` (a plain-text
   heads-up — never a secret).
2. The enrollment wizard fills that notice in for the Claude-style flow
   (`url-code-paste`). The Codex-style flow (`device-code`) is a single code, so it
   gets no notice.
3. The dashboard's Pending Logins panel shows the notice on the card, above the
   code, so you read the warning before you start.

## How do I know it works?

New tests check all three layers: the wizard's `flowNotice` returns the two-code
text for the Claude flow and nothing for Codex; starting a Claude enrollment stores
that notice on the pending login and it survives onto the phone surface; and the
dashboard renders a notice row when one is present and omits it when there isn't.

## Who gets this and is anything risky?

It ships with the normal instar update (server code + dashboard), so every agent
gets it without any manual step. The notice is static guidance text rendered as
inert, sanitized text — it can't be a link or run anything, and accounts without a
notice render exactly as before. Codex enrollment is untouched.
