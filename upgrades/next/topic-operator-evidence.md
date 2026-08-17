---
user_announcement:
  - audience: user
    maturity: stable
---

## What Changed

Topic-operator records now preserve evidence of how they were established. Previously, the manual `POST /topic-operator` route accepted any non-blank `uid` from its request body and stored the same `authenticated-inbound` provenance as a real authorized Telegram message. The record's authentication claim was a constant, so downstream readers could not distinguish evidence from assertion.

The manual route remains available but now writes an honest `operator-api-assertion` record. Raw assertions are inspectable, but every authority-bearing reader refuses them. The two live Telegram ingress paths attach evidence only after their existing sender-authorization check; that evidence names the ingress, authorization decision, sender uid, and inbound message id. The store independently checks the evidence, including that its uid matches the binding, before any record becomes a verified operator or enters advisory replication.

Legacy rows with no evidence, forged self-reports, mismatched ids, missing message ids, and malformed records all resolve to not verified. An authorized Telegram message re-establishes a legacy topic through the normal evidence-bearing path.

The read API now separates authority from inspection: list/read responses include filtered verified `operators` and separately labelled raw `bindings`.

## What to Tell Your User

Your topic's verified operator is still bound automatically from authorized Telegram messages; there is no new setup step. The difference is that Instar now keeps evidence of that authenticated path and will not treat a manually supplied uid—or an old row with no evidence—as operator authority.

If a topic temporarily shows no verified operator after upgrading, send an ordinary authorized message in that topic. That lets the live Telegram path re-establish the binding with evidence. Instar will not guess in the meantime.

## Summary of New Capabilities

- Distinguish a real authenticated operator binding from a manual assertion in durable state and API reads.
- Refuse assertions, forged provenance, legacy evidence-less rows, and malformed evidence at every verified-reader boundary.
- Preserve the concrete ingress, authorization decision, sender uid, and message id that established a verified operator.
- Keep manual assertions inspectable without replicating or granting authority to them.

## Evidence

- A before/after reproduction drives the real HTTP route and reads the real JSON store: the same arbitrary body uid changed from a false `authenticated-inbound` record to an `operator-api-assertion`, while verified reads return null.
- The authenticated negative control drives the real lifeline-forward route and observes exact path-derived evidence in the durable store.
- Targeted verification covers the store, manual route, both authenticated ingress paths, replication, session-context injection, principal coherence, topic profiles, bias-to-action wiring, and cross-machine advisory behavior.
- The type-preserving negative control keeps the exported predicate and signature but changes its body to `return true`. TypeScript compiles cleanly, all 16 then-current guard tests execute, and four fail on behavioral assertion mismatches. The restored predicate passes.
- A Phase B adapter maps P1–P5 and all four P3 sabotages to live production code. Its acceptance verdict is intentionally reserved for an independent lane.

## Known Limits

- Establishment evidence is a structured local record, not a cryptographic attestation. The verified-writer census is currently the two authenticated Telegram paths and is pinned by tests.
- WhatsApp and Slack do not yet establish verified topic operators through this store; future writers need their own recognized evidence variants.
- Store corruption continues to degrade to “no verified operator” without a dedicated corruption alert.
