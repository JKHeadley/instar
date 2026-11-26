# Plain and Complete notices — the short version

**What this is.** When Instar's server sends you a message on its own, for example after restarting a session or moving a conversation to another machine, that message is written in code by a developer. It doesn't go through the AI check that reviews messages a session writes. That is deliberate: if the AI is down, an alarm still has to reach you. The side effect is that nothing checked whether those messages made sense to a person. On 2026-11-03 Justin got "This conversation moved machines mid-task (drain bound (30000ms) reached — final turn may be partial). Work resumes on the new machine — the final turn before the move may be partial." It pasted an internal reason straight in, said the same thing twice and didn't name the machine. He asked for a standard: messages must be easy to digest and carry just enough information to be useful.

**What already existed.** The UX standard already said names must never be replaced by ids (Rule 7). The constitution already said routine self-narration ("I restarted") should not be sent at all (Near-Silent Notifications). Session-written messages already pass a tone gate, and scheduled jobs get a jargon and file-path advisory. None of that covered how the server's own fixed notices are worded.

**What is new.**
1. A written rule, Rule 8 "Plain and Complete", in Justin's words. Every message says what happened, what it means for the person and what they need to do, once and in plain words. It can fail by being too vague or too technical. It comes with real before/after examples.
2. One catalog file holds the server's fixed notices. A test reads every one for internal words, ids, timeouts, reason codes and file paths, and for messages too short to say anything.
3. A build check looks at every place the server sends a message (Telegram and Slack) and refuses new code that pastes a raw internal reason, such as an error message or a reason code, into your text. Today's remaining cases are frozen in a list that may only shrink. They are tracked for rewriting as feedback item fb-d1c2f259-243.
4. Four real notices rewritten: the moved-machines one (now names the machine, says the step may be incomplete, and tells you to ask for a check, since nothing re-checks it automatically), both restart notices, and the pinned-settings note.

**Safeguards.** Nothing here runs when a message is sent, so no message can be delayed or blocked by it. Code that recognises the server's notices by their wording (so they are never mistaken for a real reply) now reads the same catalog, so a reworded notice is still recognised. Old wordings stay recognised because they are still in message history.

**What you need to decide.** Nothing. The standard could not go into the constitution registry itself, because registry changes need a signed approval and no approval key is installed yet. It lives in the UX standard, which the registry already points to. Installing the key is Echo's job.
