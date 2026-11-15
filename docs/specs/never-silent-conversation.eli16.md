# Never-Silent Conversation — the short version

On 2026-11-13 Inspec stopped answering Justin for over four hours. Its only Claude sign-in had
run out. Claude Code showed a new message ("Login reached its time limit"). Instar only knew the
older wordings, so it noticed nothing, switched nothing, and told nobody.

Adding the new wording to the list would just fail again the next time Claude Code rewords it.
So this design changes three things:

1. **Notice by behaviour.** If someone sends a message and no reply goes out, that is the alarm,
   whatever the screen says.
2. **Let a model judge why.** A judge reads the screen, the engine's own sign-in status and the
   account state, and decides: sign-in ran out, usage limit, stuck on a startup question, crashed,
   or just slow. The judge runs on a different engine (for example Codex), so it isn't stuck behind
   the same dead login. The old word lists become hints for the judge. They no longer decide.
3. **Act, and always say so.** Move the conversation to an account that works. If there isn't one
   on Claude, move it to Codex. Answer a safe startup question, and start the sign-in repair, which
   Codex can drive too. Whatever happens, Instar posts a plain message in that conversation saying
   what went wrong and what it did. If even the judge can't run, Instar still says "your message
   wasn't answered and I'm looking into why".

The account list also stops showing a signed-out account as "active".

**If you chose the engine yourself.** Some conversations are set to Claude on purpose. For those,
Justin decided on 2026-11-14: "ask, as long as it is robust and minimally interrupting for the
user". So the message that tells you what went wrong also carries one button, "Move to Codex".
You don't have to type anything or open another page. If you tap it, the conversation moves and
answers you. If you don't tap it, it stays on Claude while the sign-in repair keeps going, and you
hear back once the repair works or fails. The button is never sent again on a timer, and a second
tap does nothing harmful. Conversations nobody set to a particular engine move on their own.

**What stays off at first.** The notices and the honest account status turn on first. Automatic
moves and keypresses stay off for each kind of failure until the judge has been tested against
real screens from past failures and made no wrong calls. The first proof runs on a throwaway test
agent, never on Justin's own conversations.

No settings need changing to get this: it is on for development agents and off elsewhere until it has proven itself, and the automatic moves have their own switch.
