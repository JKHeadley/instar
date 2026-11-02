## What Changed

A promise that waits only for the operator's yes or no now has Approve and Decline buttons in the console. Approve hands the next step back to the agent; Decline closes the promise. The decision is posted in the promise's conversation and handed to its session.

## What to Tell Your User

When I'm waiting for your go-ahead on something, the dashboard now has Approve and Decline buttons, so you don't have to type the answer in chat.

## Summary of New Capabilities

- `POST /commitments/:id/decide` with `{"decision":"approve"|"decline","note":"..."}` for a pending promise blocked on the operator.

## Evidence

Operator request 2026-11-01 with a screenshot of a waiting promise that offered only "Reply in the conversation" and "I handled this". Unit tests cover the route (approve, decline, refusals) and the page model.
