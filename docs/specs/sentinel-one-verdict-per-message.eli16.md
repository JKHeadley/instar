# One stop decision per message (plain-English overview)

## What happened

Every message Justin sends goes past a safety check before it reaches the agent. The check asks one question: is this person telling the agent to stop right now? If the answer is yes, the server ends the agent's session at once. That is how "stop" keeps working even when the agent is in the middle of something.

For an ordinary sentence, the check asks an AI model. The model's answer is not exactly the same every time. On the evening of 2026-11-17, Justin sent a photo with the words "This plan is NOT working. the wrong account is growing: dawn and NOT healdey.justin". That is a correction, and the agent should have kept working and fixed the plan. Instead the session was ended and he got "Session terminated."

## Why it happened

On this agent, messages reach the server through a small relay program (the lifeline). The relay waits 10 seconds for the server to accept a message. If it hears nothing back, it sends the message again. That evening the AI check took 5 to 13 seconds per message, so the relay kept re-sending the same message. Each re-send ran the check again.

The saved records show the model was asked about this one message 7 times. It answered "this is a correction" 6 times and "emergency stop" once. The single "stop" answer came on the second try, and one stop answer is enough to end the session. So the session was not ended because Justin asked for a stop. It ended because the same question was asked over and over until one answer came back wrong.

## What changes

The server now remembers its decision for each message, by the message's own id and exact text, for 15 minutes. When the same message arrives again (a relay re-send, or a redelivery after a restart), it gets the first decision instead of a new one. If the first check is still running when the re-send arrives, the re-send waits for that same answer.

This applies to Telegram messages (both ways they reach the server) and to messages from the phone app.

## What does not change

- A plain "stop" (or any word on the fixed stop list) still stops at once, every time, without asking the model.
- When the model decides a message really is a stop, that is still a real stop. Every repeat of that message is a stop too.
- Different messages are still checked separately, and so is an edited message whose text changed.
- If a check fails with an error, nothing is remembered, and the next delivery is checked again.

## What is left

This removes the repeated asking, which is what turned one unlucky answer out of seven into a dead session. A single wrong first answer can still end a session. The rules say a stop the model infers is a real stop, and changing that is a rule change for Justin to decide, so it is not part of this fix.
