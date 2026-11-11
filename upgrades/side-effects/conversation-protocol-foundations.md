# Conversations protocol and identity prerequisites

Atomic prerequisite checkpoint under the reviewed v3 design and its recorded operator provenance. The later owned-machine/no-required-paid-service instruction remains explicit; this document creates no new approval or convergence marker. This component does not activate Conversations, install a witness, remove a machine or expose a route.

## Scope and authority

Closed protocol dependency group: shared bounded publication ordinals, custody profiles, typed record/signature validators, sealed bundles, owner-control recovery envelopes, permanent-loss consent/native proof/pin validation, exact local durability/path helpers, the optional native durable-revocation transaction, and erased configuration type declarations. Functions verify structured data and signatures; they do not establish current human intent, current owner authority, native lease ownership or completed storage merely from a JSON shape or a valid old signature. The actual service/native/owner paths must supply those live proofs before actuation. See docs/signal-vs-authority.md.

The owner-control envelope is encrypted to the exact signed installed recipients. It is not a public custody-role private key or a new cloud credential. Ordinary native revoke keeps its existing path; revokeDurably adds journal-first flush/recovery and exact historical audit lookup for the separately gated permanent-loss protocol. No machine is revoked by importing these modules.

## Side effects

1. Over-block: malformed signatures, mismatched rosters/keys, missing envelopes, unsupported rank bounds, invalid native proof and unreadable durable state refuse verification. No heuristic grant or permissive fallback.
2. Under-block: cryptographic validation is explicitly not fresh owner/device admission. A signature alone cannot authorize native removal or a new Source receipt; live authority remains outside this component.
3. Reach: prerequisite definitions and shared types only until runtime consumers are integrated. No user flag is enabled and no adapter sends a message.
4. Privacy: sealed content/key envelopes remain opaque; validators reject extra private/plaintext fields. Public consent contains opaque identities and source commitments, not effort titles. Native revocation journals retain existing public registry/audit metadata, not private signing keys.
5. Compatibility: native lease counters are not clamped by graph publication bounds. The graph declares its own safe-integer rank subset and must refuse its own admission before overflow; existing native behavior remains independent. Legacy external custody signatures are not relabeled owned custody.
6. Multi-machine: exact signed membership/profile/recipient binding is required. These parsers do not prove independent failure domains, all-member durability, recovery availability or backup erasure.
7. Rollback: remove unused prerequisite imports/definitions before runtime activation. Preserve existing identity epochs, revocation journals and audit evidence; never reverse a real revocation as a code rollback.

## Verification and second pass

Protocol-consent and existing native identity tests will be run on the frozen component. Whole graph tests elsewhere are separate evidence; this prerequisite is not a full feature or deployment pass. Independent source/side-effects review is required before its normal Tier-2 commit. Original approved-spec provenance is preserved exactly rather than fabricating new approval metadata.


Concern raised: GraphOwnerRecoveryStore.ts:21-22,31-40 accepts independently rooted actual native identity/revocation stores and storage stateDir. A foreign IdentityStore with no member entry supplies unrevoked epoch-zero state rather than the identity home’s tombstone, before a positive signed recovery receipt. Bind canonical native/store/storage roots (or enforce an explicit alternative physical association) and cover wrong-home/revoked-home cases. Source-level review only; no production route exploit or independently executed RED claimed. Exact identities and bounded review: `.instar/state/build/review-protocol-foundations-commit.md`. Concurrence withheld pending resolution.

Resolution: actual-class negative cases confirmed the concern, then Store SHA256 `841f919621f5b4c6085662d15a7857f1813f4758df1e8c99445af1be12bfaa6b` added canonical native/storage/epoch-root association at construction and use. Independently reread source and four actual-native home tests; observed author's corrected normal 52/52 PASS in `root-protocol-owner-home-fixed.log` (not an independent rerun). Concur with the review for the thirteen-file prerequisite source/side-effects checkpoint only, with this corrected Store hash. No integrated-feature, activation or release approval; normal hooks remain required. Full exact identities/limits: `.instar/state/build/review-protocol-foundations-commit.md`.
