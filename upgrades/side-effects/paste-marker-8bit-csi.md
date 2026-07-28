# Side-effects review — paste-marker sanitiser: 8-bit CSI

**Change:** one regex in `SessionManager.rawInject` — `/\x1b\[20[01]~/g` → `/(?:\x1b\[|\x9b)20[01]~/g`.
Two tests added.

## Direction of effect

Strips **strictly more** of one specific control sequence. Nothing else is touched.

| input | before | after |
|---|---|---|
| `ESC [ 201~` (7-bit) | stripped | stripped |
| `CSI(0x9b) 201~` (8-bit) | **passed through** | stripped — the fix |
| `ESC [ 200~` (7-bit start) | stripped | stripped |
| literal `"[201~"` with no control byte | untouched | untouched (asserted by a new test) |

All four verified by running the patterns, not by reading them.

## Why widen rather than adopt a full C0/C1 strip

PR #158 proposes `sanitizeForPaste()`, which strips the entire C0/C1 range and substitutes an ellipsis.
That is broader and catches this case too — but it also **alters legitimate message bytes**, which is a
behavioural change to every injected message and deserves its own review.

This change removes only the sequence that can forge a paste boundary, so no legitimate content is
rewritten. If #158 lands later, its broader sanitiser supersedes this cleanly.

## What this does NOT claim

**No exploit is asserted.** Whether an 8-bit CSI is honoured depends on the terminal/TUI mode, and I
have not tested tmux or the Claude Code / codex TUIs. What is proven is that the sanitiser does not do
what its own comment says — *"Strip any EMBEDDED bracketed-paste markers"* — while covering one
encoding.

That is worth closing regardless: this guard exists precisely because *"the headless `-p` argv path was
immune, and InputGuard only scans topic-bound sessions, so rerouted job/A2A prompts need this sanitizer
at the chokepoint."* A defence-in-depth guard with a coverage gap is worth fixing before someone
discovers whether the gap is reachable.

## Blast radius

`rawInject` is the injection chokepoint for every message to every session — the highest-consequence
function I touched tonight, which is why the change is one regex rather than a restructure. It can only
remove more of an already-forbidden byte sequence; it cannot alter delivery of anything else.

## Verification

- Red → green: the 8-bit test fails without the change (1 failed / 24 passed), passes with it (25/25).
- The benign-literal test passes in **both** directions — that is what shows the widening did not start
  eating ordinary text.
- `tsc --noEmit` clean.
