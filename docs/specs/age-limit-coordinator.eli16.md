# The age limit no longer ends a session in the middle of its work: plain-English overview

## What happened

Every session has an age limit (usually 4 hours plus a buffer). Past it, the
server checks every few seconds whether the session is still doing anything.
If it is, the server leaves it alone. If it looks idle, the server ends it for
good ("terminal"), and nothing brings it back until someone writes into its
chat topic.

On 2026-09-29 at 02:32 PDT the Instar 2.0 coordinating session on the Mac
Studio (15 hours old, topic 52075) was ended this way. It was not idle. A
background watch it was waiting on had just finished, and the session was in
the middle of reading the result. Its transcript had been written two seconds
before the kill. All three "is it working?" checks missed it at that moment:

- **Screen check.** It looks for the status-bar text Claude Code shows at the
  prompt. That text is on screen during a turn too, so it proves nothing by
  itself.
- **Process check.** The watch command had just exited, so there was no child
  process for those few seconds.
- **Transcript check.** It looks for recent writes to the session's
  transcript file. It was looking up the file by a session id that a hook had
  briefly overwritten with one that has no file, so it found nothing.

Earlier checks had seen the session working (the watch was running). But each
check was judged alone, so one bad sample was enough.

## What changed

- **A short memory.** If the age check saw the session working in the last
  10 minutes, it still counts as working. One blind sample can no longer end
  it. The memory renews whenever the existing "is it working?" decision says
  working. That is the same three checks as before: a running command, fresh
  transcript writes, or a screen that does not show the idle prompt. An empty
  or unreadable screen also counts as working, as it always has.
- **The memory forgets ended sessions.** Every check drops entries for
  sessions that are no longer running, so it cannot grow without limit.

The session's own transcript shows its background watch ran until eleven
seconds before the kill, and a running watch counts as work. So the memory
alone would have kept this session.

A first version also added a new check that treated the on-screen text
"esc to interrupt" as proof of work. Review showed that text can sit in old
screen output after the work ends, which would keep an idle session alive
forever. That added check is gone.

The three original checks are still imperfect. The screen check and the
process check can be wrong, and the session-id mix-up that blinded the
transcript check is not fixed here. The memory only smooths over short blind
moments; it does not make the checks better.

## What did not change

A session that is really stale is still ended by the age limit. The memory
expires 10 minutes after the last check that said working. After that, the
next check that says idle can end the session, subject to the same keep rules
and back-off as before. So 10 minutes is not a hard limit from when the work
really stopped: while the old checks keep saying working (for example the
screen does not show the idle prompt), the session is kept, exactly as it was
before this change. All other keep rules (recent user message, open
commitment, and so on) are unchanged. There are no new settings, messages, or
routes.

## Why not "restart and resume" instead

The brief allowed either keeping the session or turning the kill into a
restart that resumes the conversation. Here the session was working, and the
existing rule already says "don't kill a working session". The bug was that
the rule could not see the work. Fixing that adds almost no new code. A
restart path would add a new revival route for a session that should never
have been killed.
