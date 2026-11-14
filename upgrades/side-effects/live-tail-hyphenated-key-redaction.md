# Side-Effects Review — redact hyphenated sk-family keys whole

**Version / slug:** `live-tail-hyphenated-key-redaction`
**Date:** `2026-11-14`
**Author:** `Echo (helper session)`
**Second-pass reviewer:** `not required`

## Summary of the change

The live-tail scrubber (`src/core/liveTailRedaction.ts`) redacted `sk-` keys only when 16 unbroken alphanumerics followed `sk-`. Anthropic keys (`sk-ant-api03-…`, `sk-ant-admin01-…`, `sk-ant-oat01-…`) and OpenAI project / service-account / admin keys (`sk-proj-…`, `sk-svcacct-…`, `sk-admin-…`) and OpenRouter (`sk-or-v1-…`) put a short word and a hyphen there, so the rule never fired and the whole key went over the wire. A new ApiKey rule matches those explicit prefixes (Anthropic prefixes must end in digits) followed by 16+ key characters, anchored by a lookbehind so `task-proj-…` slugs stay untouched. `REDACTION_CATEGORY_VERSION` goes 1 → 2 (recorded on each flush; nothing gates on it). The same flaw was fixed in sibling scrubbers: `ClaimObservation` (provider-bound redaction), `openConversationBrief` and `PromiseBeacon` (drop-on-secret checks) now catch `sk-ant-…`, and `postDriveTranscriptAudit` excerpt sanitizer gains the hyphenated sk-family shape. The existing cross-file ratchet (`tests/unit/outbound-credential-wall-modern-formats.test.ts`) now also pins `liveTailRedaction.ts` and `postDriveTranscriptAudit.ts`.

## Decision-point inventory

- `liveTailRedaction RULES` — modify — one more redaction pattern (text transform, not a gate).
- `ClaimObservation.prepareClaimObservation redact` — modify — one more alternative in the scrub regex.
- `openConversationBrief SECRET_VALUE_RE`, `PromiseBeacon.redactSecrets`, `postDriveTranscriptAudit SECRET_SHAPES` — modify — extra alternative; on a match these degrade a summary/excerpt to generic text, as before.

---

## 1. Over-block

Text like `sk-proj-` followed by 16+ slug characters (e.g. a branch named `sk-proj-some-long-kebab-name`) is redacted in the live tail. Accepted: the tail is the most sensitive stream and the file comment already prefers over-redaction. For `sk-ant-` the live-tail and audit rules require digits in the prefix, so `sk-ant-colony-walked-…` prose is left alone (tested). The three drop-style checks use the repo-standard `sk-ant-[A-Za-z0-9_-]{20,}` (same as durableSecretScrub / credentialShapes); a kebab phrase starting `sk-ant-` there would degrade one summary to generic wording, harmless.

## 2. Under-block

Vendor prefixes not in the list (a future `sk-<newword>-…`) still slip the live-tail rule; the explicit list is deliberate to avoid redacting ordinary kebab text. Keys split across lines are not handled (unchanged).

## 3. Level-of-abstraction fit

Right layer: these are the per-surface scrubbers. A shared module (`durableSecretScrub`) exists but the live tail keeps its own named, versioned category set by spec (§8 G3c); the cross-file ratchet keeps the copies from drifting.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

Redaction rewrites text before it leaves the machine; the drop-style checks only swap an excerpt for generic wording. Nothing is refused or held.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Credential shape matching is a safety floor on an irreversible action (a key leaving the machine).

## 5. Interactions

Rule order: the new rule runs before the generic ApiKey rule; both emit the same category, so counts and labels are consistent. Bearer/secret-assignment rules run earlier and may already consume a key after `token=`; either way the key is gone. Receivers record `redactionVersion` only.

## 6. External surfaces

Live-tail flushes to peer machines now carry `[redacted:api-key]` instead of these keys, and `redactionVersion: 2`. No user-visible wording changes.

## 6b. Operator-surface quality

No operator surface touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

machine-local BY DESIGN: each machine scrubs its own outbound tail before sending; a mixed-version pool simply records version 1 or 2 per flush. No notices, no durable state, no URLs, no status surfaces changed.

## 8. Rollback cost

Revert the commit; no data migration, no state repair.

## Conclusion

Small, reversible pattern fix closing a real key leak in the live tail and three sibling scrubbers, with tests on both sides of the boundary.

## Second-pass review (if required)

Not required: pattern-only redaction change with no gate, session-lifecycle or block/allow surface.

## Evidence pointers

- `tests/unit/liveTailRedaction-hyphenated-keys.test.ts` — 11 of its tests fail on main, all pass with the fix.
- `tests/unit/outbound-credential-wall-modern-formats.test.ts` — ratchet now covers the two new copies.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (this is a source-code regex defect).
