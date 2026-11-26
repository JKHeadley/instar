# Side effects: WhatsApp Business API calls have a 15-second timeout (SEC-132)

In plain words: every request the WhatsApp Business API backend makes to Meta now gives up after 15 seconds, so a stalled connection fails like a network error instead of hanging.

Tier 1. Size: 1 source file (one constant, six one-line additions), 2 new unit cases.

## What changes for running agents
- `META_API_TIMEOUT_MS = 15_000`; each of the six `fetch` calls in `src/messaging/backends/BusinessApiBackend.ts` passes `signal: AbortSignal.timeout(META_API_TIMEOUT_MS)`.
- On a timeout, `fetch` rejects with a `TimeoutError`, exactly the path a dropped network connection already took: `connect()` catches it and reports the connection failure; the send, read-receipt and reaction methods let the rejection reach their caller, as a network error already did. No caller sees a new kind of failure, only a bounded wait. Callers: text sends put the message back on the outbound queue (`WhatsAppAdapter.ts:437`); read receipts and reactions are `.catch(() => {})`; interactive sends fall back to plain text (`CrossPlatformAlerts.ts:134`); `connect()` goes to disconnected.
- Known, not new: if Meta accepts a send but answers after 15 seconds, the queued retry can send it twice. A dropped connection could already cause this; the timeout makes it somewhat more likely on a very slow Graph API.
- A normal answer (well under 15 seconds) is unchanged.
- Only the Business API backend is touched; the Baileys (WhatsApp Web) backend keeps its own socket handling.

## Signal vs authority
Bounds how long a call can wait; grants and blocks nothing.

## Rollback
Revert the commit. No state change.

## Tests
- `tests/unit/BusinessApiBackend.test.ts`: 56 pass, 2 new, both failing on main.
  - All six calls (connect, text, template, interactive, read receipt, reaction) pass an AbortSignal, and `AbortSignal.timeout` is called with 15000 six times.
  - With the timeout shortened to 20 ms and a fake server that never answers, a text send rejects; without the signal it would hang, and on main the test hits its 2-second limit.
- Also pass: `WhatsAppWebhookRoutes`, `CrossPlatformAlerts`.

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose, fresh context, given only the diff and the problem statement), 2026-11-21. Verdict: concur, no blocking findings. It confirmed:
- The six calls are the only Graph API calls in `src/` (no media upload or download).
- The signal also bounds the body reads.
- Every caller already handles a rejection, so there is no new unhandled rejection.
- 15 seconds fits small JSON calls.
- Both tests fail on main.

Its non-blocking notes, all handled: the possible duplicate send after a late accept (recorded above), test spies restored in `afterEach`, and the "retry" wording in the user note (made exact).
