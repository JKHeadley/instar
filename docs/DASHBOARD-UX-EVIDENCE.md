# Why Instar needs a real dashboard: one approval, five hours, four asks

Commissioned by the operator, 2026-10-19, during the episode it documents: *"My god this is
terrible user experience. We need to document this as proof that we need a full dashboard and
UI/UX experience for Instar."*

This is a case study, not an opinion. Every failure below is specific, traceable to a mechanism
in the current code, and was experienced by the operator in one sitting while trying to perform
**one approval**.

## The task

The feedback executor refuses to run while the agent could act as the GitHub approver. Clearing
that requires the operator to accept the dependence once, through a PIN-gated control on the
dashboard's Feedback Drain tab. One decision. One tap, plus a PIN.

It took five hours, four explicit asks from the operator, and it had still not completed when
this document was written.

## What actually went wrong, with mechanisms

### 1. The page showed an empty section and explained nothing

`dashboard/feedback-triage.js` renders the accept control only when
`data.execute.reason === 'approver-not-independent'`. That field comes from the executor's
availability check. After the host restarted for an auto-update, the check had not run, so the
field read `not-checked-yet` and the section rendered **empty**.

The operator saw a blank area. The page did not say "nothing is waiting on you", did not say
"we have not checked yet", and did not offer a way to check. There is no distinction in the UI
between *nothing to do*, *not yet determined*, and *something is broken* — three states that
mean completely different things to a person deciding whether to wait or act.

> **Implication.** Every panel needs an explicit, authored empty state that names which of those
> three it is. An unexplained blank region is indistinguishable from a bug, and the operator
> correctly concluded it was one.

### 2. The button's label named the concession, not the decision

Once the control did render, its text was:

    Let it run anyway…

The operator had been told — repeatedly, by the agent — to look for an approve or accept control.
No such words appear on screen. He reported, accurately, *"There is no confirm or approve button."*

> **Implication.** A control's label must name the decision the person is making in their own
> terms. "Let it run anyway…" describes the agent's relief at being unblocked, not the operator's
> act of approving. Labels written from the system's point of view are unfindable by the person
> looking for their own intent.

### 3. The PIN is requested twice with no explanation of the difference

The operator reaches the dashboard by entering a PIN. The approval then asks for the same PIN
again. His words: *"entering in my pin seems redundant and useless since I have to have the pin
to get to the dashboard anyway."*

He is right that it *reads* as redundant. It is not — the second entry is the authorisation,
distinct from the door — but nothing on screen says so.

> **Implication.** When a system asks for the same credential twice for genuinely different
> reasons, it must say what the second one authorises. Otherwise a deliberate safety step reads
> as incompetence, which trains the operator to resent and distrust it.

### 4. Nothing surfaced *why* the action was blocked or *who* could clear it

The executor's state (`available: false`, `reason: approver-not-independent`, `dryRun: true`) is
available over the API and is genuinely informative: it is blocked, here is why, here is who can
change it, and even once cleared it stays in practice mode. None of that reached the operator as
plain language on the page. He had to ask the agent, four times, what was happening.

> **Implication.** A blocked action should state, in place: what it is waiting for, who can
> provide it, and what will and will not happen when they do. The information already exists;
> only the surface is missing.

### 5. The Confirm button reads a PIN field in a different card

`dashboard/feedback-triage.js` appends the PIN input to `card` (line 136) — the sorting-authority
card. The executor's accept control is built in a separate container `ex`, appended independently
(line 205). The confirm handler then reads `(pin.value || '').trim()` from that *other* card's
field (line 192).

So the button and the field it consumes are in visually unrelated sections, connected only by a
line of small text reading *"enter your PIN in the box above"* — which does not say which box, or
that it belongs to a different panel. The operator pressed Confirm with an empty field and got a
rejection for a step he had no way to know he had skipped.

> **Implication.** An input and the control that consumes it belong in the same visual unit. If
> they cannot be, the control must name the field explicitly and show whether it is filled.

### 6. The control duplicates itself on every press

The same handler does `exBtns.appendChild(confirm)` on each click of "Let it run anyway…", with no
check for an existing confirm button. The operator pressed it three times — reasonably, since
nothing visible had happened — and ended with **three identical "Confirm with PIN" buttons**
stacked down the page.

Three identical confirm buttons is not a cosmetic defect. To a person it reads as *the system is
confused*, or *these do different things*, and it actively discourages pressing any of them.

> **Implication.** Idempotent controls. Pressing a prepare-step twice must not produce two
> confirm paths, and a press that appears to do nothing must say what it did.

### 7. The operator became the integration test

Each of the above was discovered by the operator hitting it, reporting it in frustration, and
the agent then reading the code to find out why. That sequence — ship, let the operator find it,
explain afterwards — is the process failure the *Live-User-Channel Proof Before Done* standard
exists to prevent. This episode is a clean instance of the escape it is meant to catch.

> **Implication.** The standard's north-star metric, *operator-found escapes*, should be measured
> against the dashboard specifically. Tonight contributed at least six.

## The pattern underneath

Each failure is the same shape: **state that the system knows and the page does not say.**

- The executor knew it had not checked; the page showed a blank.
- The code knew the button's purpose; the label named the agent's side of it.
- The server knew why the second PIN differs; the form asked twice in silence.
- The API knew the block, the owner, and the practice-mode caveat; the operator had to ask.

This is not a shortage of features. It is a dashboard that renders data without ever explaining
itself, and a person is left inferring a system's internal state from an absence of text.

## What a real dashboard would have to do

0. **Fix the two outright bugs first**: the PIN field and its Confirm button must share a visual
   unit, and the prepare-step must be idempotent. Both are small and both blocked a real approval.
1. **Authored empty states** distinguishing *nothing pending* / *not yet known* / *failed to load*.
2. **Labels in the operator's language**, naming their decision rather than the system's relief.
3. **Blocked actions that explain themselves in place** — what, who, what happens next.
4. **Credential prompts that say what they authorise** when asked more than once.
5. **A live view of pending decisions** so a decision is never discovered by being asked for it.
6. **Measured against operator-found escapes**, not against whether the data is technically present.

## Honest scope of this document

This records one episode. It is strong evidence because the mechanisms are identified rather than
guessed, but it is a single operator on a single flow, and three of the seven failures were
*compounded by the agent's own wrong guidance* — being sent to a tab with no link, then to a
control that was not rendering, then told to look for words that were not on it. A dashboard
rebuild would not have prevented those; clearer agent communication would. Both are real, and
separating them matters: the UI failures above stand on their own, and the communication failures
are recorded in the run log for 18330 rather than blamed on the interface.
