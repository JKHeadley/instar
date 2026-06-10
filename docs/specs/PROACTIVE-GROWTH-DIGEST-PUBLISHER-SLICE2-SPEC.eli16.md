# Growth Digest Publisher (Slice 2) — plain-English overview

## What is this?

Echo already has a "growth analyst" — a piece of code that quietly watches whether
your projects are stalling, whether dark features have proven themselves enough to
turn on, how often you change a spec the same way, and how often you correct Echo.
Today it *computes* all of that and you can read it on demand (a web route), but it
never **tells you** anything on its own. You opened this whole thread asking for the
opposite: *"I have YET to have an agent proactively check in with me about ANY of
these."*

This slice builds the part that speaks: a small component that, on a schedule
(default: Monday 11am), takes the analyst's already-computed picture, writes ONE
short "growth check-in" message, and posts it to your Agent Updates topic on
Telegram. That's it. It adds no new spying — it just gives the existing analysis a
voice, once a week, in one place.

## What changes for you if it ships?

Once it's turned on, you get a single weekly message like: "📊 Growth check-in — 3
initiatives waiting on you, 1 feature ready to promote, 2 stalling." The big list
(you currently have 205 stalling initiatives) is summarized to the top few with a
"+200 more" line, so it's never a wall of text. The important stuff (a feature
that's ready to promote, a misconfigured dark feature) is always shown in full and
never cut off.

Crucially: **on a quiet week where nothing needs your attention, it stays silent by
default.** You killed the burn-detector alerts because they were noisy, so a weekly
"all healthy, nothing to do" message would be the same mistake. It only speaks when
there's something worth speaking about (you can opt into a steady heartbeat if you
ever want one).

## How it rolls out (safely)

It ships turned **off**. Then on Echo only, it goes to "dry-run" — it writes the
exact message it *would* send into a log file so you can see a real sample without
being buzzed. You read the sample, and if you like it, we flip it to "live." The
fleet stays off. The feature literally follows the same dark → try-it → turn-it-on
maturity path it reports on.

## What the review process changed

The first draft was sound but the multi-reviewer convergence (security, scalability,
adversarial, integration, lessons-aware, plus an outside model) caught three things
worth knowing about:

1. **It would have double-sent on your two-machine setup.** The old job it replaces
   only ran on the "awake" machine; the new in-process timer would have run on both,
   sending the check-in twice. Now it only sends from the machine holding the lease.
2. **It could have accidentally bypassed the spam guards.** The shared "is this
   message OK to send" check was tangled up with the web-request code. We untangled
   it into one clean function that both the web route and this publisher call, so
   there's provably one chokepoint, not two.
3. **The quiet-week silence** described above — the reviewers flagged that a weekly
   no-action message would re-create the noise you already rejected, so the default
   is now "stay quiet unless there's something to say."

A late mechanical fix: the wiring snippet had used a wrong API name for the
"which machine is awake" check; the integration reviewer caught it by reading the
real code, and it's corrected.

## The tradeoffs

- **Weekly vs. some other rhythm** — weekly Monday is the default; you can change the
  day/time, and the timezone is configurable so "Monday 11am" is *your* 11am.
- **One bounded edge case**: if the two machines hand off control at exactly the
  wrong moment, you might get one check-in twice. That's deliberate — the whole point
  is "the check-in arrives," so we bias toward a rare duplicate over a silent miss.
- **It replaces the old near-silent initiative digest** so you don't get two voices
  on the same initiatives.

Nothing here can block, delay, or rewrite anything — it only ever *sends a message or
stays quiet*. It's a voice, not a gate.
