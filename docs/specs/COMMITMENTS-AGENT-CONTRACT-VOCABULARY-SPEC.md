# Commitments Agent Contract Vocabulary Spec

## Problem

Agent-facing guidance documented an invalid commitment create payload:

- It used `type:"follow-up"`, but the API accepts `config-change`, `behavioral`, or `one-time-action`.
- It omitted `agentResponse`, but the route and `CommitmentTracker` require it.

The runtime lifecycle is healthy when callers use the actual contract. The gap is that templates could teach agents to send a payload the server rejects.

## Contract

For a one-time follow-up promise, generated guidance must show:

- `type:"one-time-action"`
- `userRequest`
- `agentResponse`
- `topicId` when the commitment is tied to a Telegram topic

The lifecycle status vocabulary remains canonical:

- `pending` when the commitment is open
- `delivered` when `POST /commitments/:id/deliver` closes a one-time follow-up
- `verified`, `violated`, `expired`, and `withdrawn` for the existing verification and terminal flows

The word "open" is a human verb in the guidance, not an API status value.

## Verification

Tests must cover three layers:

- Template/migrator guidance contains the valid payload and rejects the stale `follow-up` type.
- Route-level tests create the documented one-time follow-up shape and deliver it.
- E2E API lifecycle opens, inspects, delivers, re-inspects, and confirms the delivered commitment is no longer active.

PromiseBeacon stop behavior stays covered by the existing integration lifecycle test: delivery emits a terminal state and scheduled beacon work is removed.
