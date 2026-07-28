# Apprenticeship Cycle Store — plain English overview

## What this change is

The apprenticeship program already tracks big lifecycle state: which onboarding
instance exists, who the overseer is, who the mentor is, who the mentee is, and
whether the instance may start or complete.

This change tracks the smaller repeated loop inside an apprenticeship.

Each time a mentee does a task, the system can now save one "cycle":

- what task the mentee tried
- what the mentee produced
- what the mentor noticed
- what the overseer noticed differently
- what coaching came out of that comparison
- what infrastructure follow-ups should exist
- whether the cycle is still open or closed

## Why it matters

Before this, the important learning loop could live mostly in chat. That is
fragile. Chat is hard to query later, easy to lose in summaries, and too easy to
skip when the next mentorship starts.

Now the loop has a real SQLite table and an API. That makes the learning
evidence durable.

## What already existed

- An apprenticeship instance registry.
- Lifecycle routes for creating instances and moving them through status gates.
- Tests that prove the lifecycle routes are alive.

## What's new

- `ApprenticeshipCycleStore`, a SQLite store with one row per differential
  cycle.
- Four authenticated routes:
  - `POST /apprenticeship/cycles`
  - `GET /apprenticeship/cycles`
  - `GET /apprenticeship/cycles/:id`
  - `POST /apprenticeship/cycles/:id/close`
- Unit tests for persistence.
- Integration tests for auth, validation, 404s, and the full route flow.
- An e2e alive test that proves the real server returns success, not 503.

## What you need to decide

Nothing for this PR. It is additive. Existing apprenticeship instance behavior
does not change.

## How to verify it worked after deploy

Record a cycle with `POST /apprenticeship/cycles`, list it with
`GET /apprenticeship/cycles`, fetch it by id, and close it with
`POST /apprenticeship/cycles/:id/close`.

If the route returns 503, the server did not open the cycle store. If it returns
201 on record, the feature is live.

