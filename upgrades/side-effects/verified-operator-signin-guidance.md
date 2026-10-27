# Side-Effects Review — Verified subscription sign-in guidance

**Version / slug:** `verified-operator-signin-guidance`
**Date:** 2026-10-27
**Author:** Echo
**Second-pass reviewer:** independent agent review, 2026-10-27

## Summary of the change

Tier 1: a reversible guidance correction across seven files and two new review documents. The built-in `/subscription-signin` skill, generated agent instructions, and existing-agent migration now distinguish existing exact-identity unattended approval from new actions, verified human approval from peer assertions, and a first Google session from proven cold recovery. Tests cover installation, migration idempotency, and Claude/Codex/Gemini instruction parity. This changes agent-facing advice; it does not change runtime admission, credentials, or passkey configuration. The signed cross-agent receipt is tracked in issue #2413.

## Decision-point inventory

- `SubscriptionReloginPolicy` — pass-through: no predicate or configuration changed; existing exact-identity unattended policy remains the repair authority.
- `TopicOperatorStore` and Threadline identity — pass-through: no identity binding or transport code changed. The guidance names their current limits.
- Agent reasoning at sign-in time — modified by instructions: agents are told to read standing policy and observed repair state before asking for approval, and never to treat a peer assertion as human proof.

---

## 1. Over-block

No new runtime block/allow surface. At the instruction layer, an agent may delay a new enrollment while seeking direct approval even where a separate valid mandate already exists. The text explicitly accepts a PIN-authored scoped mandate and a future verified operator-origin receipt; existing unattended repair is checked first.

---

## 2. Under-block

No new runtime block/allow surface. An agent could still disregard written guidance or misread a peer's claim. A programmatic cross-agent receipt and point-of-use verifier are required to close that class; issue #2413 tracks it. A warm Google session can still expire; the text names this and does not claim cold recovery.

---

## 3. Level-of-abstraction fit

The immediate defect is incorrect installed guidance, so the built-in skill plus generated instructions and their migrator are the correct layer for this correction. The cross-agent authority feature belongs in authenticated ingress, signed identity transport, and the target's repair/enrollment gates, not in prompt text. This change does not imitate that missing gate.

---

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md).

- [x] No — this change has no runtime block/allow surface.

The text asks agents to treat a peer claim as a signal and resolve authority from existing exact-identity policy or authenticated operator proof. It does not add a brittle matcher or direct 403 response.

---

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The migration's content-sniff string is an idempotency guard for installing text, not a judgment about user intent or authorization.

---

## 5. Interactions

- **Shadowing:** The migration appends the new bullet once; the existing subscription guidance remains intact. The skill migration touches only an installed default skill that retains the known heading and frontmatter.
- **Double-fire:** No new runtime event, notice, or action is emitted. Running migration twice yields the same file.
- **Races:** No shared runtime state is modified. Existing agents receive text on update; new agents receive it on init.
- **Feedback loops:** A user may receive fewer duplicate approval requests, but no automatic action is triggered by this patch.

---

## 6. External surfaces

Claude, Codex, and Gemini agent instructions change after init/update. The sign-in skill text changes on existing default installations through `PostUpdateMigrator`; user-customized skill content outside the known insertion point is preserved. No API, Telegram message, credential, remote service, durable ledger, or new operator-facing action is added. A future approval receipt needs a phone-completable surface; this patch does not pretend one exists.

---

## 7. Multi-machine posture

Agent instructions replicate by installation/update on each machine; the underlying operator binding stays local by design. The change adds no per-machine state, notice, URL, or topic-owned durable record. The current subscription pool's `?scope=pool` view remains the source for account-by-machine status. It must not be confused with cross-agent approval authority.

---

## 8. Rollback cost

Revert the source and ship a patch. The migration appends a section to existing instruction files; rollback can remove that exact marker with an idempotent migration. No credential or repair state needs reversal. During rollback propagation, agents may still use the newer guidance; it grants no runtime authority.

---

## Conclusion

The guidance correction is fit to ship after the required checks. The security-sensitive receipt remains a separately tracked implementation (#2413), and this change explicitly refuses to treat ordinary peer messages as its substitute.

---

## Second-pass review (if required)

**Reviewer:** independent agent reviewer (read-only)
**Independent read of the artifact:** concurred with Tier 1 and the authority boundary. Flagged partial migration with the marker already present, peer-reported Scout state presented too strongly, and missing operator-confirmed scope in the future receipt contract. Resolved by independently sniffing stale recovery prose, labeling Scout observations as peer reports, and requiring scope to come from or be confirmed in authenticated operator flow.

---

## Evidence pointers

`npm run build` passed; 223 focused tests passed across migration, install, and feature-delivery parity; 49 lint checks passed. The full `npm run test:all` rerun is queued behind an active merge verification at review time.

---

## Class-Closure Declaration (display-only mirror)

`defectClass: claim-vs-evidence`, `closure: gap`, `gap: GitHub issue #2413`. The misleading skill text was an agent-authored artifact defect: a peer's bare “operator approved” assertion could be mistaken for human evidence. This change tells agents to refuse that inference; only a point-of-use cryptographic verifier can close it structurally. No self-triggered controller is added or modified (`unbounded-self-action`: not applicable).
