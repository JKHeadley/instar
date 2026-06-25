# Framework Permission-Prompt Robustness — Plain-English Overview

> The one-line version: a new safety popup in the coding tool can silently freeze
> the agent on a question nobody can answer from a phone. We make the agent answer
> that popup itself, automatically and safely, every time — so it never gets stuck.

## The problem in one breath

Recent versions of Claude Code (the program Instar runs inside) added a hardcoded
safety popup. Whenever a command starts with `cd somewhere && ...` **and** also
sends output somewhere (using `>`, `>>`, `|`, or `2>`), the tool stops and asks on
the terminal: *"Do you want to proceed? ❯ 1. Yes / 2. No / Esc to cancel."* This
popup runs so early that none of the usual "just allow everything" settings can
turn it off — we checked, and there is genuinely no switch for it. Instar already
runs with permissions skipped, and the popup still appears.

That is a disaster for a remote agent. The session is **alive** and even printing
fresh text (the popup), so every "is this session stuck?" watcher thinks it is busy
working — one of them will even tell the user "actively working." But the agent is
actually frozen, waiting for someone to press a key on a keyboard nobody is sitting
at. You cannot answer a terminal Yes/No from Telegram or the dashboard, so the agent
sits there forever, silently. That makes Instar useless until a human walks over to
the machine.

## Why it actually happened (the real cause)

Instar already has a "Prompt Gate" that watches the screen for popups and can
auto-press a key. It is supposed to be on by default. But on this very agent we
found it was switched **off** in the saved settings — and once a setting is saved as
"off," a new "on by default" never reaches it. So there was nothing answering the
popup at all. That same trap (a safety feature quietly stuck "off") is exactly what
we must avoid repeating.

## The rule that drives the fix

The operator was clear: a low-level popup like this is **never** a real decision for
the user. Instar runs the operator's own machine with full access. The user should
only be asked about big, risky things (spending money, irreversible changes, going
out of scope) — and those already have their own separate guards. A session frozen
on a tiny "press Yes" popup is a **bug to fix automatically**, not something to
forward to the user.

## What this adds

**1. Auto-answer (the main fix).** A small new watcher checks each running session
every few seconds. The key safety idea: it only acts when it sees a **real, live
menu** on screen — the actual highlighted `❯ 1. Yes` selector the tool draws — not
just the *words* of the popup. That distinction matters, because the agent might be
*looking at* a file, a web page, or a pull-request description that happens to
contain those words. We can't be 100% certain from a text snapshot that those words
are a real menu versus content that looks just like one — so we are honest about
that and rely on layers of safety instead of a perfect test: the watcher only ever
presses **Enter** (confirm the highlighted "Yes"), never a riskier key, so even in
the rare case it is fooled by look-alike content the worst outcome is a harmless
blank Enter that the tool ignores. It double-checks the menu is still there the
instant before pressing, it only tries a few times, and if it genuinely can't clear
the popup it stops and raises a "please look" notice rather than pressing keys
forever. Every action
is logged. This is the durable, tool-independent fix: it works no matter which coding
tool we run, because it just reads the screen and presses the right key.

**Always on, and it can't get stuck "off."** Unlike the old Prompt Gate, this floor
is on in the code itself — there is no saved "on" setting that could later rot into
"off." The only way to turn it off is a deliberate, visible emergency switch, and if
anyone ever flips it, the system treats that as an incident and flags it.

**If it genuinely can't clear a popup** (say a future version of the tool changes the
wording), it does **not** hammer keys forever and it does **not** hide the problem:
after a couple of tries it stops and raises one clear "a session is stuck on a popup I
couldn't auto-answer — please look" notice. That is the one and only time a human
hears about this, and it doubles as our early warning that the tool changed.

**2. Notice it (so we can measure it).** We teach the existing "why is this session
stuck?" classifier to recognize this popup as its own named state, purely for our
logs and dashboards. While the auto-answer watcher is handling a session, the
standby messaging stays quiet (using the same "someone already owns this recovery"
logic it already has) — so the user never gets a "respond in Telegram" nudge for it.

## What we removed after review

The first draft also had a "prevent" layer — a guard that would catch the risky
command shape before the popup appeared. Reviewers (including an outside GPT model)
showed it relied on an unproven assumption about timing, contradicted its own
"off by default," and tried to solve the genuinely-hard problem of parsing shell
commands. Since the auto-answer layer clears the popup anyway, we **dropped** the
prevent layer to keep the fix simple and robust.

## Why this is safe

Pressing "Yes" here only approves a command the agent already decided to run on the
operator's own machine — it could already have run the same command in a form that
doesn't trigger the popup. To be honest about the trade-off: this particular popup
exists to catch an unusual "redirect to an unexpected place" trick, and no Instar
guard re-checks *that specific thing*, so we accept that residual risk under the
"this is the operator's own machine, full access" model. What we are **not** doing is
unlocking anything new: the real safety guards — the catastrophic-command blocker
(`rm -rf /`, force-push, dropping databases), the external-action gate, the coherence
check, the mandate — all still fire on top, and we prove that with a test that a
genuinely destructive command stays blocked even when this watcher approves the popup.
We are only clearing a **menu**, never widening what the agent is allowed to do.
