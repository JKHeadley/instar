# Starting the agent's own conversations on a machine with room

## What is going on

The agent runs on several computers, but on 17 November one of them, the Mac Studio, carried 23 working sessions while the Laptop carried none. The Studio slowed down badly. Its server stopped answering for up to a minute and a half at a time, and test runs took twice as long.

When a person starts a new conversation, the agent already picks a computer with room. When the agent starts work for a conversation itself (a review, a spec round, a long stewardship run), the work always starts on whichever computer received the request. That was 18 of the 23 sessions.

The first step of this work (already built, waiting to merge) does two things. It records where every session would go if it were placed by load. And it places small helpers that don't belong to any conversation. This second step does the same for the agent's own conversation work.

## What changes

When the agent asks to start work for a conversation and says "place this where there's room":
- **If the conversation is already running somewhere,** the work goes there, just as now. A conversation is never split across two computers.
- **If this computer is busy and another has room,** the work starts on the other computer. It uses the same careful hand-over the system already uses to start a person's conversation on a chosen machine. That hand-over claims the conversation first, so it can never end up running twice.
- **Later messages in that conversation** go to the computer it now lives on, the same way they do for a person's conversation.
- **If anything is uncertain** (the other computer doesn't answer clearly), nothing is started a second time. The agent is told which computer has it, and a person is told if it still can't be confirmed after ten minutes.
- **If the work fails to start on the other computer,** that computer posts a notice in the conversation, so it's never silently lost.

## Safeguards

- It only happens when the caller asks for it ("auto" placement). Everything else behaves exactly as today.
- It only moves work when this computer is busy and another one genuinely has room, and only when memory isn't short there.
- It runs first on the development agent only, and on a two-computer test setup before that. Other agents get it only after a review of real numbers.
- Turning it off is one setting and a restart.

## What needs deciding

Nothing from the operator. The Chief of Staff approves the design.
