# Plain-English overview — stop automated messages from sending you jargon or raw file paths

## What this is

This morning a background reminder reached you that broke two of my own rules: it used developer
jargon, and it pasted a raw file path you can't click instead of a real link. You asked me to fix
it structurally, not just promise to do better. This is that fix.

## The surprising part (what I found when I dug in)

There's already a guard that checks every message I send you before it goes out — and it already
knows to block raw file paths and to flag jargon. So the real question wasn't "build a guard," it
was "why did this message slip past the guard that should have caught it?"

I found two specific holes:

1. **The jargon check was never actually turned on for chat replies.** The guard *can* detect
   jargon, but the chat-reply path never asked it to. So jargon was never getting checked on the
   main way I message you — for any message, not just the background one.

2. **The raw-file-path check only worked when the smart guard was fully running.** That guard is
   designed to "let the message through" if it's slow or overloaded (so it never freezes your
   messages) — and it's skipped entirely for certain system/relay messages. There was no simple,
   always-on backstop for a raw path the way there already is for an un-clickable link. So under
   those conditions, a raw path could slip through.

## The deeper root cause (what a careful review found)

When I first wrote this fix, the review caught a real flaw: my plan relied on each background job
*remembering to label itself* as "automated." But that's the same trap that caused the problem —
the background model that ignored the rules in the first place isn't going to reliably remember to
label itself either. So the real fix had to be structural: the system itself stamps "this is an
automated message" onto every background-job message automatically, before the message is even
composed — the job (and the model running it) does nothing and can't forget.

## The fix

1. **Automatically mark every background-job message as "automated"** at the moment the job starts
   — stamped into its environment by the scheduler, not typed by the model. A normal conversation
   with you is never marked this way. This is the key piece: now the guard can always tell an
   automated alert from a real conversation.

2. **Always run the jargon check** on automated messages (not on normal conversation, where talking
   about internals is fine), so the guard actually sees and weighs jargon in alerts.

3. **Add a simple, always-on backstop for raw file paths** — but only for *automated* messages.
   Those have no good reason to ever show you a raw path; they should link or describe. For my
   normal conversation with you, the smart guard stays in charge (so if I mention a file like
   `src/foo.ts` while chatting, that's a judgment call, not an automatic block). This keeps me from
   over-blocking my own legitimate messages — which I know you care about. The backstop is built
   carefully so it can't crash, can't be tricked into looping, and never leaks a secret that
   happened to sit next to a path.

## What you need to decide

- This turned out bigger than "patch two holes": the real fix makes the system structurally tell
  automated messages from conversation. I think that's the right call (it's the only version that
  actually closes the hole), but it's a slightly larger change — confirm you want the structural
  version and not just the lighter patch.
- Everything can be turned off instantly with a config switch if anything feels too aggressive.
