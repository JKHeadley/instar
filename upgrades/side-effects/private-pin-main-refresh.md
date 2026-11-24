# Side-effects review for the private dashboard PIN branch refresh

Date: 2026-11-24
Scope: PR 3414, reviewed merge commits `f60dcddfe` and `8a5c63b55`.
Original authority: [approved spec](../../docs/specs/identity-security-piece1d-pin-private.md) and [original review](identity-security-piece1d-pin-private.md).

The refresh keeps both update migrator imports and their original call sites. The first merge combines the private PIN instruction rewrite with the conversation search guidance migration. The second imports release metadata and keeps the private PIN release note byte-identical under `upgrades/next`.

- **Over-block.** Both migrations remain reachable. PIN instructions still use the existing phrase table and search instructions still use the upstream migration. No new refusal was added by the conflict resolution.
- **Under-block.** The original delivery rules and their residual limits still govern. The approved fallback remains bounded to the original conditions where no private route is available. The refresh adds no delivery exception.
- **Layer and authority.** The migrator owns instruction updates. Delivery authentication, destination checks and fallback decisions remain in their original runtime owners. The merge introduces no new decision point. See [Signal vs. Authority](../../docs/signal-vs-authority.md).
- **Interactions.** The PIN rewrite retains its original sweep and the search guidance retains its existing content transform. Independent review verified both call sites and checked the automatically merged files. The release-note conflict changed no runtime or test files from the reviewed refresh.
- **External surfaces and machine posture.** The conflict resolution does not add a recipient, route, or cross-machine state path. The original delivery outcome is local to each machine and PIN generation. Existing polling-owner and paired-phone conditions continue to govern the approved fallback.
- **Rollback.** Restore the prior held branch head if a merge interaction is detected. This refresh review adds no migration or data repair requirement.

## Verification

The exact refresh passed 24 unit, 36 HTTP and 14 production lifecycle tests, TypeScript and all 55 normal lint steps. PR 3406 remains a prerequisite for verification and release. These results cover the refresh and do not constitute full shared verification or a physical-device test.

Second-pass review concurred. The reviewer checked the approved-spec and original-review links, both migration call sites, the metadata-only release merge, and the retained release fragment against the two reviewed commits.
