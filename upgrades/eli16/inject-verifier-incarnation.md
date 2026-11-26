# ELI16 — why a restarted session was reported as a lost message

## The thing that was broken

When the agent sends a message into one of its own terminal sessions, it types the text in and presses Enter. On recent versions of the Claude Code terminal interface that Enter is occasionally swallowed, and the text just sits in the input box, unsent. So there is a checker: right after typing, it looks at the screen a few times — at 0.5, 1.5, 3.5, 6.5 and 9 seconds — and if the text is still sitting at the prompt it presses Enter again, harder each time. On the last look it presses nothing and only reports: either the message went through, or it says plainly "this message was never delivered" and files a fault.

That last report was firing when nothing had been lost.

The reason is that the checker recognises "my message" by two things that both survive a restart: the first forty characters of the text, and the name of the terminal session. One of the recovery steps restarts the session and sends the message again. The restarted session has the same name, and the message it was just handed has the same first forty characters — so one second after the restart, the screen looks exactly like the failure the checker was waiting for. It was comparing a one-second-old attempt against a nine-second deadline, saw text still at the prompt, and announced a loss.

## How we know it was a false alarm and not a real one

On the Mac Studio, the five-minutely health-check job did this four times in one hour. For each of those four runs the log shows the same three steps in order: the message gets stuck, the session is restarted, the checker declares the message undelivered. And then the records show that the restarted session ran the health check properly, printed its completion marker, and was closed as a success. One of those restarted sessions' own transcripts was read directly: four replies from the model, a finished health report in plain English, and the completion marker printed once. The work happened. The alarm was wrong.

## What changed

The checker now remembers *which attempt* it is checking, not just what the text looks like. Every session has a native conversation id, and a restart gives it a new one — the log even says so: `claudeSessionId rotated … (respawn/resume)`. The checker takes that id when it starts, and at every look compares it to the current one. If it changed, this screen belongs to a different attempt, so the checker stops and says so in one line. It does not need to do anything else, because the restarted attempt typed its own message and therefore started its own checker.

Two deliberate exceptions, both erring toward doing nothing:

- A session can be messaged before its conversation id has been assigned at all. Going from "no id" to "an id" is the first assignment, not a restart, so it does not stop the checker.
- If the state file cannot be read, the id is unknown, and an unknown id is not evidence of a restart. The checker carries on exactly as it did before.

## Why this matters more than one noisy warning

That warning is the only place the system says out loud that a message to a session was lost. A warning that cries wolf in exactly that spot is how a real lost message gets ignored — and it was also being forwarded into the bug-report pipeline, so the noise travelled.

It is also the same mistake, for the third time in one day, of watching a *state* instead of an *identity*: "is that text at the prompt?" cannot distinguish "still not sent" from "just sent again", in the same way that "has the published version changed?" could not distinguish "not yet" from "never". The answer each time is to anchor the watch on something that is different per attempt, and to treat only a different one as news.

## What a reader should check if this ever looks wrong again

The abandon is logged, not silent: look for `Injection verification for "<session>" abandoned at attempt N: the session was respawned`. If that line appears and a message really did go missing, the restarted attempt's own checker is the thing to investigate — it owns that delivery, and it has its own nine seconds.
