# Removing the "two codes" sign-in disclaimer — plain-English overview

## What this change actually is

When you set up a new Claude account on an Instar agent, the sign-in flow used
to attach a warning to every pending login: "Heads up: a brand-new Claude login
often asks for TWO codes in order — first an email-verification code Anthropic
sends you, then the sign-in code shown after that." That warning appeared in the
dashboard's pending-login panel, in the account-grid sign-in cells, and in
Telegram messages that relayed the login link.

The warning was written in early live testing (topic 20905), when Anthropic's
sign-in page really did ask for two codes on most brand-new logins. That
behavior has since become rare — the operator reports not having seen it in a
long time — so the disclaimer had turned into noise: repeated on every single
enrollment, describing a step that almost never happens, and making the flow
look more complicated than it is. The operator asked for it to be removed
outright rather than reworded.

This change deletes the notice at its source. `EnrollmentWizard.flowNotice()` —
the one and only function that produced the text — is removed, along with the
line in `EnrollmentWizard.start()` that attached it to each pending login.

## What stays

The *plumbing* for notices stays: the pending-login store still has an optional
`notice` field, the API still passes it through, and the dashboard still renders
a notice if one is present. That machinery is generic and harmless — it simply
has nothing to say right now. If a future flow genuinely needs a heads-up, the
field is there. The tests that cover the render path now use neutral fixture
text ("this provider may show an extra verification step") so the coverage
survives without shipping the stale advice anywhere in the codebase.

The engineering comments explaining why remote enrollments get a *larger
timeout budget* (the sign-in can still occasionally involve an extra
verification step, especially on mobile) also stay — that rationale is about
timeouts, not user-facing messaging, and it is still true.

## What you actually need to decide

Whether removing the disclaimer entirely (rather than showing it conditionally)
is right. The operator made this call explicitly on 2026-07-23: the extra step
"MIGHT still happen when going through the flow on mobile," but it is rare
enough that a permanent warning on every enrollment is the wrong trade. If the
two-code window returns in force, the correct fix is a conditional notice driven
by observed provider behavior — not restoring a blanket disclaimer.

## Risk, in plain terms

Near zero. No decision logic, no gate, no authority changes — only static text
removal. The worst case is a user hitting the rare two-code sequence without a
warning, which costs them a moment of confusion on the provider's own page; the
flow itself works identically either way.
