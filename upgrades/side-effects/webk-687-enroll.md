# Side-Effects Review — Telegram Web K 687 enrollment

**Version / slug:** webk-687-enroll
**Date:** 2026-11-11
**Author:** Echo
**Second-pass reviewer:** not required (data-only addition to an existing reviewed allowlist; see section 4)

## Summary of the change
Tier 1. One runtime file, data only: `ReviewedWebKBuilds.ts` adds Web K 2.3 (687) with its three exact asset names and SHA-256 digests, backed by `docs/specs/reports/telegram-message-origin-evidence/web-k-2.3-687-review.md`. One unit test pins the entry, its fingerprint (equal to the live canary's) and the two-build enrolled list. No driver, broker or route code changes. Effort: one source-map review by a helper, independently spot-checked (digests re-fetched, fingerprint recomputed, four driver-critical sources compared byte-for-byte).

## Decision-point inventory
- Reviewed-build list: an existing authority (enrollment admits only listed builds). This adds one reviewed entry. The CLI canary still requires the exact bytes, the expected account and self-peer resolution.

## 1. Over-block
None: the entry only widens the allowlist by one exactly-pinned build.

## 2. Under-block
A page that served these exact bytes with different worker files is not covered by the critical-asset filter; that is unchanged from earlier builds and the review recorded the worker and map digests for audit. Any later build needs a new review.

## 3. Level-of-abstraction fit
The reviewed list is the designed place for this; no runtime input can add a build.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. No new authority and no new logic; one reviewed data row in an existing code allowlist.

## 4b. Judgment-point check
None.

## 5. Interactions
`nextSupportedBuilds` keeps the new build plus one prior (686) on enrollment; the unit test pins that.

## 6. External surfaces
Once a machine runs the reviewed enroll command, its managed Telegram browser sends and snapshots work again on build 687. Response bodies are unchanged.

## 7. Multi-machine posture
The build list ships in code to every machine. Enrollment is machine-local BY DESIGN (machine-local-justification: physical-credential-locality): each machine's managed profile holds its own Telegram session and is enrolled by its own canary.

## 8. Rollback cost
Plain revert. A machine enrolled at 687 would fall back to holding (409) until a new reviewed release ships; 686 stays in the enrolled list as the prior build.
