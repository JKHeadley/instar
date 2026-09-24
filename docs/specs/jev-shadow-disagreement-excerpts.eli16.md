# Making disagreements settleable — plain-English overview

## What Changed

We are running a trial comparing a cheap model against the checks I already
use for deciding whether an outgoing message leaks something technical. Over
two days it compared 350 messages and the two sides disagreed on 49.

That number sounds useful and is not. The trial records only a fingerprint of
each message, never the message. So we can count the disagreements and we can
never find out who was right. It is not evidence for the model and it is not
evidence against it. Ending the trial on that number would have been the worst
outcome, because it looks like a result.

## What's new

On a disagreeing comparison only, the trial now keeps a short snippet of the
message — just the part in dispute — so a person can look and say which side
was correct.

Three things bound what gets kept:

- **Only disputed rows.** If both sides agree, nothing is kept at all. Most
  messages produce nothing.
- **Only the disputed part.** My existing checks report exactly where in the
  message they found something. The snippet is a small window around that spot,
  never the whole message, hard-limited in length.
- **Secrets are stripped first.** Anything that looks like a key or token is
  replaced before the snippet is written, and only the number of things removed
  is recorded.

There is a deliberate gap. Sometimes the model flags something my checks did
not — in that case there is no location to anchor to. Rather than widen the
window to the whole message to cover it, the trial records "no location to
anchor to" and keeps nothing. Less data, honestly labelled, beats more data
taken by stretching the rule.

## Safeguards, in plain terms

- Off unless switched on. With the setting absent, behaviour is exactly as
  before and nothing is kept.
- A daily limit on how many snippets are kept, and the limit being hit is
  written down rather than passing silently.
- Snippets stay on this machine, in the same local trial log as everything
  else. They are not sent anywhere. The full messages already go to the model
  for comparison — that part is unchanged and was approved separately.
- If stripping secrets fails for any reason, nothing is kept.

## What to decide

Nothing. The operator already approved keeping stripped snippets of disagreeing
messages. This builds exactly that, no wider, and it can be switched off by
removing one setting.
