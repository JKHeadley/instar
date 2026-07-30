# Honest Threadline delivery receipts — Plain-English Overview

> The one-line version: sending a message now distinguishes “someone accepted responsibility for it” from “the receiving agent actually processed it.”

## The problem in one breath

Threadline used one success-shaped result for several very different events: a relay accepted bytes, a receiver queued work, a live session received the message, or a spawn was refused. The final sender-facing tool then turned almost every successful HTTP request into `delivered: true`, so a message that never reached a live agent could look fully delivered.

## What already exists

- **Fast receiver acceptance** — receiving servers acknowledge authenticated messages before a potentially slow session spawn, preventing sender timeouts from creating duplicate retries.
- **Retryable spawn admission** — temporary memory, cooldown, quota, and session-cap refusals can retain a payload for a later drain attempt.
- **Reply waiting** — callers can optionally wait for a reply on the same conversation thread.
- **Delivery tracking** — the separate agent-to-agent tracker records sends and later acknowledgements, but the immediate send result did not respect that distinction.

## What this adds

Every relevant layer now carries two separate facts. `accepted` means the next layer retained responsibility for processing; `delivered` means there is concrete evidence of processing, such as live-session injection, a completed spawn/resume, explicit processing, or a reply. A verified receiver's asynchronous HTTP acknowledgement is therefore `accepted: true, delivered: false`. Sending bytes into the relay socket without waiting for its acknowledgement is only a submission, so it remains `accepted: false, delivered: false` unless a reply later proves processing. A spawn refusal is not handled or delivered; it is accepted only when the current payload really entered the bounded retry queue.

The sender-facing tool no longer upgrades transport success into delivery. If an older compatible response omits the new fields, the fallback can infer acceptance from successful transport, but it infers delivery only from concrete evidence such as a reply.

## The new pieces

- **Explicit router outcomes** — every router exit identifies whether the message was accepted, delivered, or queued. Autonomy blocks and errors are neither accepted nor delivered; approval queues are accepted but not delivered.
- **Honest accept boundaries** — both authenticated receiver endpoints say explicitly that asynchronous work is accepted but not yet delivered. A duplicate retry is suppressed conservatively and does not claim acceptance because the earlier attempt's current state may be unknown.
- **Honest sender mapping** — local, relay, HTTP-helper, and MCP responses preserve those facts instead of collapsing them into a generic success.
- **Queue-admission evidence** — a retryable spawn refusal reports whether this particular payload actually entered the queue, including bounded-cap rejection.

## The safeguards

**Prevents submission from masquerading as acceptance or delivery.** Relay socket submission and duplicate suppression can return a successful operation result while both receipt facts remain false. Asynchronous receiver acknowledgement and approval queueing are accepted but cannot silently become proof that a live agent processed the content.

**Prevents refusal from masquerading as handling.** A real spawn denial returns an unhandled result, and its acceptance flag is tied to actual queue admission rather than the presence of a retry interval.

**Prevents the honesty fix from duplicating work.** The production relay listener previously retried any threadless message when `handled` was false. It now retries only when the router also failed to resolve a thread; a refused payload with a resolved thread cannot be handed to the router twice.

The warm-worker path also stops after a transient refusal that already queued the payload. It no longer falls through to a cold-worker evaluation and queues the same inbound a second time.

**Preserves fast acknowledgement.** The receiver still responds before the slow spawn. This change does not reintroduce the timeout-and-duplicate failure that the asynchronous accept boundary fixed.

## What ships when

This is one source-compatible patch: the exported result fields remain optional for older fixtures while the built-in router always supplies them. Runtime rollout is directionally conservative. An updated sender interpreting an older receiver will not promote missing delivery evidence. An older sender can still apply its historical `delivered:true` default to an updated receiver until that sender upgrades, so the false-positive is fully removed only after the sending machine carries this patch.

## What you actually need to decide

No operator decision or feature toggle is required; this corrects the meaning of the existing delivery result.

## Verification

Every new behavioral assertion was first shown failing against the unfixed revision. After the final hardening change, all 341 assertions across the 15 changed receipt, wiring, integration, and end-to-end test files pass. The silent-fallback ratchet remains exactly at its existing 495-item baseline, and the full lint/typecheck and production build gates pass. The broad local sweep also exposed unrelated session-launch fixture/config leakage and tmux timing failures in untouched files, so the authoritative sharded CI run remains the final merge gate rather than being papered over as locally green.
