# Slack files.info Self-Check Fix + Ghost-Text Guard for the Stuck-Input Watchdog — ELI16

Two small fixes from the same live audit (roadmap item 0.5), shipped together.

## Fix 1: The Slack "can I read files?" self-check was failing itself for no reason

### What is this?

Every time the agent's Slack connection boots, it runs a quick self-test: "can I
actually do the things my token says I can?" One of those checks asks Slack's
`files.info` API about a file that deliberately doesn't exist. The point isn't
the file — it's proving the API answers at all. If Slack says "file not found,"
great: the API is alive, our token works, check passed.

The problem: the fake file id we used (`F000SELFTEST`) looked wrong enough that
Slack rejected it BEFORE even looking for the file — it answered
`invalid_arguments` instead of `file_not_found`. Our check only knew how to
treat "file not found" as healthy, so it stamped a big red ❌ on a perfectly
working connection, at every single boot.

### The fix

Two layers, so it can't regress from either direction:

1. **Use a properly-shaped fake id** (`F0000000000` — the shape Slack expects,
   just guaranteed not to exist), so a healthy workspace answers the stronger
   "file not found."
2. **Teach the check what `invalid_arguments` actually means.** If Slack's
   validator answered at all, then the network, our login, and the endpoint all
   just proved themselves — which is everything this check exists to prove. So
   that answer now counts as a pass too. A real problem (like Slack saying our
   token is missing the permission) still fails, exactly as before.

## Fix 2: The stuck-input watchdog was pressing Enter at text nobody typed

### What is this?

The agent has a watchdog that looks at each terminal session and asks: "is there
a typed message sitting at the prompt that never got submitted?" If yes, it
presses Enter to un-stick it. Useful — messages sometimes get injected but not
submitted.

But Claude Code's terminal also shows **ghost text**: a dim, gray SUGGESTION the
model writes into the input box that nobody typed and nobody asked to send. In
the watchdog's plain screen-capture, dim styling is stripped away — so ghost
text looks byte-for-byte identical to a real stuck message. During a live run on
2026-07-02, the watchdog stared at one of these suggestions and pressed Enter at
it four times.

Nothing bad happened — today, Enter doesn't accept ghost text. But that's luck,
not safety. If the terminal's UX ever changes so Enter DOES accept the
suggestion, we'd have a watchdog auto-submitting instructions the model made up
for itself. That's one UI tweak away from a real problem.

### The fix

Before pressing any key, the watchdog now takes a SECOND look at the screen —
this time keeping the styling information (the terminal can tell us which
characters are rendered dim). Then it classifies what it sees:

- **Real input** (normal brightness) → recover it, exactly like before.
- **Ghost text** (entirely dim) → never press anything at it. Log one line so we
  can see it happened, and stand down until the text changes.
- **Can't tell** (the capture failed, the screen changed between the two looks,
  or the styling is mixed) → do NOT press anything this tick, log it, and look
  again next tick.

The rule baked in: **when uncertain, the watchdog does nothing.** Pressing Enter
at fabricated text is the dangerous direction; skipping a tick on a genuinely
stuck message just means it recovers a few seconds later once the capture reads
cleanly.

Only the dim attribute is used as the tell — not color. A theme that renders
text in gray-but-normal brightness must not silently disable real recovery.

### What doesn't change

- Genuine stuck messages still get recovered (tested both ways).
- The codex-session path is untouched: there the watchdog only ever fires at the
  exact text it injected itself, so fabricated text can't trigger it by
  construction.

## How do we know it works?

33 new unit tests: the exact live ghost frame is refused across arbitrarily many
ticks; the same text at normal brightness still recovers; capture failures,
raced frames, mixed styling, truecolor "gray that isn't dim," and cross-line dim
state are all covered; and the Slack check goes green on the exact error the
live server hit while still failing on `missing_scope` and unknown errors.
