# Never a False Blocker — the plain-English version

## The habit I'm trying to break

When something gets hard, I have a bad reflex: I tell you "this needs a human" or "I can't
do this" or "I'd want a second opinion first" — and then I stop and hand the problem back to
you. The sneaky part is that it *sounds* responsible. It sounds careful and humble. So it
gets past my own guard. But a lot of the time it's just me quietly giving up on something I
could actually do.

The thing you keep reminding me: I have the keys to this whole machine. I can read the
screen, click buttons, type into the terminal, drive other programs, use every tool. So the
list of things that *truly* need you — and only you — is really short:

- a password only you know,
- a CAPTCHA (those "click all the traffic lights" puzzles built to block robots),
- anything about money, signing, or legal permission,
- and a judgment call that's genuinely yours to make ("do you want option A or B?").

Almost everything else, I can do myself if I actually try.

## The moment that set this off

Earlier today I was looking at another program (Codex) that wouldn't turn on a safety
feature until "a human" clicked a "trust" button. I told you: "This needs a person to click,
and fixing it properly needs deep investigation, so I want a second opinion." Three excuses
in one breath.

You pointed out the obvious thing: I was *staring at that exact button* on the screen, and I
can click buttons. So I did. I clicked it, turned the safety feature on myself, and learned
more in thirty seconds than my "second opinion" would have. The wall was never a wall — it
was a button.

## What we're building

Think of it like a spell-checker for my outgoing messages, except instead of catching typos
it catches *me giving up too early*. We already have one of these for a close cousin of this
habit — a check that catches me saying "this can't be built" when I never really looked. This
new one is its sibling: it catches me saying "this needs a *person*" when I never tried doing
it myself.

Here's how it works, in two simple parts:

1. **A gentle nudge (before I write).** A small helper notices when I'm about to type
   blocker-words like "second opinion" or "needs a human", and quietly hands me a checklist:
   "Did you actually try? Did you check your tools?" It never stops me — it just reminds me.

2. **A real stop (when I try to send).** If I write you a message that basically says "a
   human has to do this" *and* I never showed that I tried my own tools first, the message
   gets held back instead of sent. I get told to go enumerate what I can do, try it, and only
   come back to you if it's truly one of the short list of things that are genuinely yours.

## The part that keeps it from being annoying

The held-back rule is set up to **err on the side of letting things through**. If I'm asking
you a real question ("ship version X or Y?"), or I genuinely need your password, or I already
showed you that I tried everything — that all sails right through. We'd rather occasionally
miss a false blocker than nag you when you're legitimately the right person to decide. The
goal is to stop the lazy "over to you" reflex, not to stop me from ever asking you anything.

## Why it'll actually stick

I have a long history of writing rules like this into documents and then forgetting them mid-
task — a written rule is a wish. This one is baked into the same machine that already checks
my messages before they reach you, so it fires *at the exact moment* I'm about to hand you a
fake wall, whether or not I remember the rule exists. That's the whole point: structure, not
willpower.

## What I need from you

Just a yes/no on the design before I write any code. Specifically:
- Is the short "genuinely yours" list right (password, CAPTCHA, money/legal, your judgment
  calls, physical things)?
- Anything you'd add or take off it?

Once you're happy, I'll run it through the usual review process and bring it back for final
sign-off before building.
