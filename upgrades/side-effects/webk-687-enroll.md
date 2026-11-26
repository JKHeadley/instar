# Side-Effects Review — Telegram Web K 687 enrollment

**Version / slug:** webk-687-enroll
**Date:** 2026-11-11
**Author:** Echo
**Second-pass reviewer:** independent reviewer subagent, 2026-11-11 (see Second-pass review below; the merge path requires one for this path)

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
Once a machine runs the reviewed enroll command, its managed Telegram browser sends and snapshots work again on build 687. Response bodies are unchanged. Replies that were held while the build was unreviewed (`unsupported-browser-build`) and are still inside their retry deadline are retried after enrollment and can then reach real chats; that is the existing designed retry of real replies, not a new send path. Deploying this release alone sends nothing: only the machine-local enroll command changes what a machine accepts.

## 7. Multi-machine posture
The build list ships in code to every machine. Enrollment is machine-local BY DESIGN (machine-local-justification: physical-credential-locality): each machine's managed profile holds its own Telegram session and is enrolled by its own canary.

## 8. Rollback cost
Plain revert. A machine enrolled at 687 would fall back to holding (409) until a new reviewed release ships; 686 stays in the enrolled list as the prior build.

---

## Second-pass review

**Reviewer:** independent general-purpose reviewer subagent (read-only; given the diff and the code, not the author's conclusion), 2026-11-11
**Independent read of the artifact + code: CONCUR WITH NOTES**

What the reviewer verified itself, not from this artifact:

- **The entry is exact and widens nothing.** `ReviewedWebKBuilds.ts` gains one entry with the same four fields, sorted asset order and 64-hex SHA-256 digests as the 686 and 684 entries; `matchReviewedWebKBuild` and `nextSupportedBuilds` are untouched; no pattern, fallback or loosened comparison.
- **The digests match the live public files.** All three assets were fetched without credentials from web.telegram.org/k/ and hashed; each equals the digest in code. The live index page references exactly these three names, the app file carries build 687, and the fingerprint recomputed from the names equals the test literal and the canary's value.
- **The source-map claims reproduce.** All twelve maps for 686 and 687 were fetched: 528 against 530 paths, none removed, the same two added and the same ten changed as the report says; the driver-critical sources named in the report are byte-identical in both builds.
- **Deploy alone sends nothing.** The list is read only by the enroll command; running sends check each machine's own registry. Refusal of unreviewed builds is not weakened.

Notes raised, and what was done in this same change:

1. The test compared the 687 digests with themselves, so a mistyped digest would have passed. Fixed: the three digests are now literals in the test.
2. No 687-specific refusal case. Fixed: a 687 page with one changed file is asserted refused.
3. This artifact did not mention that replies held during the outage are retried after enrollment. Fixed in section 6.
4. The review report said the fingerprint was not recomputed while the test said it was. Fixed in the report.

Left open, stated: the report's dependency table does not name every driver call (the test-group calls and the flag serializer); they are covered by the reproduced "only ten paths changed" comparison. The first-load dialog reset was not traced into peer lookup; a cache-missing peer would be refused by Telegram, not sent to a wrong chat. Not checkable from public files: that the authenticated page serves these same bytes (the enrollment canary's job), and that the minified bundles behave as their maps say.
