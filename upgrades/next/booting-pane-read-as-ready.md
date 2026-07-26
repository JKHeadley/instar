<!-- bump: patch -->

## What Changed

**A session's startup banner — and a session's startup QUESTION — were read as an input prompt, so
a message could be typed into a pane that could not receive it, and the delivery was logged as a
success.**

`SessionManager.detectClaudePrompt` decided a pane was accepting input if the last six
non-blank lines contained `❯`, `›`, `bypass permissions`, or a mention of `/effort`,
`/model` or `/fast`. That last clause matched a bare slash-command mention **anywhere, in
any context, including prose**.

Claude Code's startup banner advertises slash commands in prose. The pane that caused the
incident carried, verbatim:

> `…Fable 5 draws down usage faster than Opus 4.8. Run /model and`
> `select Fable to use it. Learn more: https://support.claude.com/…`

so the probe matched a promotional line and declared a still-painting pane ready.

**Observed (topic 29723, 2026-07-26).** Inbound message at `17:44:49Z`, session respawned,
pointer prompt injected at `17:45:00Z` — but that session's own start hook did not complete
until `17:45:15Z`. The paste landed fifteen seconds early, was swallowed by the TUI redraw,
and the injector wrote `Injected initial message into "…" (915 chars, after stabilization
delay)`. A success line for a delivery that did not happen. The message reached the agent
only because the start hook's unanswered-message backstop re-reads recent history — an
unrelated path that happens to cover this hole and cannot be relied on to.

**The slash-command clauses are deleted, not tuned.** A first attempt kept them and required
"status-bar shape" (line-start or directly after an interpunct). Second-pass review falsified that:
the banner uses the same shape — `· /memory to free up context` and `+1 more · /status` are BANNER
lines — so the discrimination was still vocabulary, and `· /model to opt in` matched outright. The
line-start branch also reinstated the very dependency it claimed to remove: at a fixed pane width, a
copy edit shifting the wrap by ~14 characters puts the command at column 0 and the defect returns. A
signal that cannot separate an ADVERT for a command from a STATUS BAR showing one carries no
readiness information. The structural markers were widened instead — `? for shortcuts`,
`shift+tab to cycle` and `auto-accept edits` join `bypass permissions`, so a session in auto-accept
mode no longer depends on the prompt glyph being visible.

**Second defect, found by the operator: a startup question read as ready.** Claude Code paints the
same `❯` on a menu's focused option that it uses for the input box. This is strictly worse than the
banner — text typed at a banner is lost, but Enter at a menu SELECTS AN OPTION, so an arriving
message can answer a permission question on the operator's behalf. A focused menu is now its own
state, never ready.

**The verdict is no longer a boolean.** Three consumers ask this question and one of them KILLS a
live session when the answer is not-ready. "Still painting" and "waiting on an answer" want opposite
responses from it, so the probe now names which state it saw and each caller applies its own policy;
the destructive caller leaves a menu alone, waits a bounded moment for the always-on auto-resolver to
clear it, and only then treats the session as stuck.

Classification moved into a small pure module so the incident's literal pane text is a
regression fixture rather than a paraphrase.

## What to Tell Your User

If you ever messaged me, watched a session start, and then saw it sit there doing nothing with
your message apparently lost — this was one way that happened. I was deciding I was awake by
looking for certain command names on screen, and my own startup banner mentions those command
names while advertising a feature. So I read "still starting up" as "ready", typed your message
into a screen that was still drawing itself, and recorded it as delivered.

There is a second case, sharper than the first. Sessions sometimes start by asking a question,
and the marker drawn beside the selected answer is the same one drawn for the input box. So a
session waiting on a question also read as ready. At a banner, a message typed too early is
simply lost. At a question it is not lost — pressing Enter picks an answer, so an arriving
message could have answered a permission question on your behalf. That can no longer happen.

I now wait for the actual input box, or for a footer that only exists once the app is running,
and I treat a question on screen as somewhere not to type.

One honest limit: this makes typing too early far less likely, but I still report a message as
delivered on the basis of having typed it, not on the basis of it appearing. Confirming that
typed text actually arrived is a separate change, recorded and not bundled here.

## Summary of New Capabilities

- A pane showing only a startup banner is no longer classified as ready for input, so a message
  is not injected before the session can receive it.
- A focused selection menu is recognised as its own state and is never ready, so an arriving
  message cannot select an option in a question meant for the operator.
- Slash-command mentions no longer count as a readiness signal in any form — the discrimination
  moved to markers that only exist once the TUI is running.
- All three permission-mode footers are recognised (`bypass permissions`, `? for shortcuts`,
  `auto-accept edits`, `shift+tab to cycle`), where previously only one was — so a session in
  auto-accept mode no longer depends on the prompt glyph being visible.
- The readiness verdict names which state it saw rather than answering yes/no, so the caller that
  kills a stuck session no longer kills one that is merely waiting on a question.
- The readiness decision is a pure, separately-testable function, so the pane text from a real
  incident is carried as a regression fixture instead of being described.

## Evidence

**Reproduction (before),** real pane text against the pre-fix clause:

| input | pre-fix verdict | correct verdict |
|---|---|---|
| the 2026-07-26 boot banner (contains `Run /model and`) | `ready` | not ready |
| `Do you want to proceed?` + `❯ 1. Yes` / `2. No` | `ready` | menu (never ready) |
| `Do you trust the files in this folder?` + two options | `ready` | menu (never ready) |
| `Run /fast to enable faster output on this plan.` | `ready` | not ready |

**Also falsified — the intermediate "status-bar shape" attempt,** kept here because it is the
reason the clause was deleted rather than narrowed:

| input | "shape" verdict | correct verdict |
|---|---|---|
| `⚠ Fable 5 promotional access ends soon · /model to opt in` | `ready` | not ready |
| `  · /model to switch between Opus and Fable` | `ready` | not ready |
| soft-wrapped banner putting `/model` at column 0 | `ready` | not ready |
| `opus 5 • medium • /effort` (bullet separator) | not ready | ready |

**Observed after:**

| input | before | after |
|---|---|---|
| the 2026-07-26 boot banner | ready | **not ready** |
| any prose or interpunct mention of `/model`, `/fast`, `/effort` | ready | **not ready** |
| a focused startup question (3 real shapes) | ready | **menu — never typed into** |
| ordinary output listing `1.` / `2.` above the input box | ready | ready (not mistaken for a menu) |
| a single numbered line beside the prompt | ready | ready |
| drawn input box (`❯`) / codex prompt (`›`) | ready | ready |
| `⏵⏵ bypass permissions on` | ready | ready |
| `? for shortcuts` / `auto-accept edits` / `shift+tab to cycle` | **not ready** | **ready** (newly recognised) |
| banner that has since grown an input box | ready | ready |
| empty / whitespace pane | not ready | not ready |

**Both guards refuse.** Restoring the old slash-command clause fails six assertions; removing the
menu classification fails three. Both include the discrimination guard, whose only job is to prove
the probe still tells its three verdicts apart:

```
# restoring the slash-command clause
× REGRESSION: the 2026-07-26 startup banner does NOT read as ready
× REGRESSION: a banner line in interpunct "status-bar shape" does NOT read as ready
× REGRESSION: a soft-wrapped banner putting /model at line start does NOT read as ready
× an agent echoing a slash command in its own output does NOT read as ready
× the probe discriminates > produces all three verdicts and is not stuck on one
Tests  6 failed | 12 passed (18)

# removing the menu classification
× REGRESSION: a startup question does NOT read as ready
× a menu is not ready to be typed into
× the probe discriminates > produces all three verdicts and is not stuck on one
Tests  3 failed | 15 passed (18)
```

**Scope run:** `npx tsc --noEmit` clean; every tree-scanning test under `tests/unit` plus every
test that mocks `capture-pane` (the fixtures that feed this probe) — counts in the PR body.
