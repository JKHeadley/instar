# Message-store provenance — Plain-English Overview

> The one-line version: every new Telegram message record says whether it came from a user, an agent reply, or automation, so readers no longer guess from the message's wording.

## The problem in one breath

The Telegram history currently records only direction: user messages are `fromUser: true` and every outbound message is `fromUser: false`. That makes a deliberate conversational reply indistinguishable from a health alert, update broadcast, proxy heartbeat, or other server-generated text. Systems that need to count or react to the agent's actual replies have been forced to guess from emoji and text prefixes, and those guesses produce false counts and false state transitions.

## What already exists

- **The Telegram JSONL history** — durably records inbound and outbound messages and supports both a legacy writer and a shared message-logger writer.
- **The reply route** — is the central send seam for conversational agent output, including replies relayed through the machine that owns Telegram.
- **Direct adapter sends** — carry alerts, automated updates, proxy notices, command responses, and delivery fallbacks.
- **History consumers** — use the log for presence cancellation, commitment detection, and output-coherence checks.

## What this adds

Every newly written Telegram row gets one closed, structural `provenance` value: `user`, `agent`, or `automation`. Inbound platform messages are stamped `user`; ordinary output through the reply route is stamped `agent`; direct adapter sends and explicitly automated reply traffic are stamped `automation`. This label is chosen from the code path at send or receive time, never by inspecting message prose.

The same value is preserved through the shared logger, callback, event bus, and cross-machine relay. Existing rows remain readable with no rewrite: a missing field means legacy/unknown, and consumers keep their prior compatibility behavior for those rows. New consumers can count actual agent replies directly.

## The safeguards

**No historical guessing.** Old messages are not backfilled from text, emoji, session name, or `fromUser`; absence stays absence.

**Outbound direction stays valid.** An outbound reply cannot be recorded as `user`, even if malformed relay metadata requests it.

**Cross-machine parity.** A tokenless standby sends the structural value to the Telegram-owning machine, so both sides record the same origin instead of independently misclassifying a direct automated send as a reply.

**Backward compatibility.** The field is additive. Legacy JSONL rows and non-migrated platform loggers may omit it, and existing readers continue to work.

## What ships when

This ships as one additive patch: the data contract, all Telegram write seams, relay transport, shared infrastructure propagation, selected consumers, and focused unit/integration coverage land together.

## What you actually need to decide

The operator already requested this behavior; the PR review decides whether these three structural categories and their compatibility rules correctly capture the intended distinction.
