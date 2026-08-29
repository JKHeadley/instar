# ELI16 — What this spec is and why it exists

## The problem, in one story

Justin and Echo work in 24-hour "windows." Each window has rules: read the whole history before starting, recite the tenets word-for-word at the start, middle, and end, send Justin a report every 3 hours, update the plan page before claiming the window is done. The rules are written down — but nothing *enforces* them. So they keep getting skipped, and each skip gets noticed by a human, after the fact.

Last night was the perfect example. Echo registered a "report every 3 hours" duty in four different places and told Justin the duty was protected. Then every one of those four layers turned out to be decorative: one was never actually created, one was muted by quiet-hours, one was in test-only mode, and one is silent by design. The reports never went out. Justin — not the system — noticed eight hours later. Writing a duty down is not the same as something actually doing it.

## What this spec builds

A **checklist engine with teeth** for the window process itself:

1. **The checklist is compiled from the rules' actual text, every time.** The system reads the tenets file and the window charter and derives every duty from what they literally say. If someone adds a new rule to the tenets, a checklist built from last week's memory automatically fails. You cannot pass by reciting from memory — the duties come from the bytes on disk, and quiz-style challenge facts are derived from those bytes too.

2. **Every duty needs real evidence, honestly labeled.** The system distinguishes weak evidence ("a message with that ID exists in a local file" — which is all the current gate can actually check) from strong evidence ("the stored text matches this receipt's fingerprint," "the live topic really contains this message"). Weak evidence can never be re-labeled as strong. Claims the system can't verify are marked "unknown," and "unknown" never counts as success.

3. **Every duty must name the thing that will actually DO it — and prove that thing is alive.** This is last night's lesson, made law. A duty that's still pending must point at a real, running, non-muted, non-test-mode executor whose next run happens before the deadline. A duty that's already done must show durable proof it was done. A duty whose time hasn't come yet must have an enabled trigger that will wake it up on time. A registered duty with no live executor doesn't fail quietly — it becomes a loud "open-unexecuted" finding that blocks the window from opening or closing.

4. **A window literally cannot claim "open" or "closed" while duties are unproven.** Opening requires every start duty verified. Closing requires a full census: every compiled duty accounted for, with evidence, or an explicit operator-approved waiver. There is no path around the census.

5. **Only Justin can waive a duty — and only for real.** A waiver has to be approved by the verified operator (proven by the authentication binding, not by a name appearing in a message), must name the exact duties it covers, expires, can't be reused, and the core duties — the reads, the recitations, honest expiry, honest debt — can't be waived at all. And a waived close is always announced as "closed with operator waiver," never dressed up as clean.

## What it does NOT do

It doesn't change any shared infrastructure — it's scoped to Echo only, on this machine, reversible, with an audited off-switch that falls back to the manual ritual while saying loudly that enforcement is off. And this document is a *specification*: approving it green-lights building it; nothing is built or enforced yet.

## Why it matters

Every failure this month — the premature "done," the skipped re-reads, last night's silent no-report stretch — is the same disease: a rule held by memory and good intentions. This spec moves the window rules from "things Echo promises to remember" to "things the system refuses to proceed without," which is the whole point of the project: convergence toward a constitution that is structurally enforced.
