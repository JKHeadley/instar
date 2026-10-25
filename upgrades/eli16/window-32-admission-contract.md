# Window 32 admission contract — plain-English overview

Window 32 was approved in different words from Window 31. The old lifecycle compiler treated one fixed W28/W31 checklist as universal, so it rejected the exact W32 charter and encouraged tests to smuggle the old wording back through a synthetic TENETS file.

The compiler now selects a W32 checklist only when both the window ID and the approved charter's exact fingerprint match. That checklist keeps the standing TENETS duties and adds the real W32 promises: a running executor, fresh heartbeat, reachable delivery, advancing durable work, admitted/unexpired lifecycle, bounded recovery, no registration-only green state, and the approved adversarial exit test. W31-only count, debt, omission, and post-live-soak experiments are not relabeled as W32 duties.

The opening rule still fails closed. It recognizes only the positive approved statement that requires both a registered run and initially green liveness predicates; vague, partial, or negated variants fail.

Two bootstrap failures are also repaired:

- A new ledger starts with cadence templates only. Ticks create only instances already due, never anything past the 24-hour ceiling, and close/expiry freezes the census.
- A TENETS reaffirmation can be the real seven Telegram messages. The authority reads every part live, requires one topic and one producer, honors the caller's explicit logical part order, reconstructs the bytes, and compares the exact TENETS hash. Missing, reordered, foreign-topic, or altered parts fail.
- Compiler-discovered `source.*` rows are completed only from the fresh source file and its compiled hash. They no longer pretend to be work commitments.
- W32's opening predicates are sampled from the server-owned run-liveness authority. A dry-run snapshot is observation only; only an enabled, enforcing snapshot can produce opening evidence.

The production-path fixture now proves the full opening sequence can reach `active_start` without synthetic source text or caller-supplied liveness booleans. A deployed process still needs Lane A's real run-liveness authority passed into the server seam; an absent authority fails closed.
