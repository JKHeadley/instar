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
  it. Only real signs of work renew the memory: a running command or fresh
  transcript writes. Text on the screen does not.
- **The memory forgets ended sessions.** Every check drops entries for
  sessions that are no longer running, so it cannot grow without limit.

The session's own transcript shows its background watch ran until eleven
seconds before the kill, and a running watch counts as work. So the memory
alone would have kept this session.

A first version also treated the on-screen text "esc to interrupt" as proof
of work. Review showed that text can sit in old screen output after the work
ends, which would keep an idle session alive forever. That check was removed.

## What did not change

A session that is really stale is still ended by the age limit. The only
difference is that this now happens up to 10 minutes after a check last saw
real work. All other keep rules (recent user message, open commitment, and so
on) are unchanged. There are no new settings, messages, or routes.

## Why not "restart and resume" instead

The brief allowed either keeping the session or turning the kill into a
restart that resumes the conversation. Here the session was working, and the
existing rule already says "don't kill a working session". The bug was that
the rule could not see the work. Fixing that adds almost no new code. A
restart path would add a new revival route for a session that should never
have been killed.
