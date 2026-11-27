# Quoted Replies: Bounded Design Decision

Status: design correction only; no runtime implementation, executed feature tests, full convergence or implementation approval is claimed.

Chief of Staff handoff `39e3e5f6-cec6-4b50-bf55-b9613ba107d4`, received 2026-11-23 at 11:37 PST, directs this bounded disposition: older App codecs stripping the quote relation are a disclosed compatibility limit, and durable transferable proof is outside this increment. The historical round-two review remains not converged. This decision records a scope change rather than rewriting those reviewers' findings.

The current spec removes the proposed quote-evidence event kind, witness index, duplicate enrichment, complete-frontier verification and any requirement for transferable-proof infrastructure before the first server increment. Known quotes with an unverifiable relation show "Quoted message unavailable". If every quote marker is stripped, the chip cannot be recovered and is omitted. Both limitations belong in native acceptance and release notes. No continuity standard is amended, and no fleet-readiness claim follows.

The author-owned corrections retained or completed are:

1. The machine receipt binds the replying base event and public message IDs, actual stored destination and selected original; verification compares those values to the immutable stored base. A public-ID collision or copied receipt cannot redirect the quote.
2. After conversation authorization, every unresolved source returns the same 409 and body, including hidden, ambiguous, unreadable, locally absent and unfinished lookup. No source text, author or private identifier is exposed by the unavailable projection.
3. Existing exact and contextual stop authority receives authenticated authored text before any new source/signer refusal. Quote metadata adds no stop authority, and ordinary negated discussion must not kill a session. Dedicated actions retain actual signed admission and read-quota exemption wiring.
4. Existing reservations keep fixed actor, request hash, reference, base IDs and receipt. Completed retries return the recorded result after current access checks. Missing append stays not-delivered; uncertain downstream effects stay unknown without redispatch or fallback to ordinary send.

Provider scope is also bounded: only positively verified physical namespace/source evidence admits a quote. An old Telegram topic-only row or a Slack retained-page miss is unavailable, never inferred from today's configuration. Newly recorded Telegram source namespace belongs at existing ingestion. Slack preserves its registered thread and reports exact-message native linkage unsupported. No exhaustive historical source reconstruction is required.

The App-link candidate is separate and still waiting for its allocated tests. This design change does not copy its runtime source, run a competing suite or claim that prerequisite is merged. Native app behavior still needs its owner's accepted contract and actual proof.

The design and boundary inventory receive one bounded independent review against these changed bytes. Its findings and the final disposition are recorded here before commit. Normal repository hooks remain mandatory; publishing goes through Chief with the exact branch and commit.

## Independent Design Review

The independent `quote_bounded_review` agent read the corrected spec, companion, boundary matrix and this decision record. It concurred with no material design error across security, integration, scalability, adversarial behavior, decision completeness and prior lessons. It independently grounded the reused immutable-base, durable-reservation, receipt-verification and contextual-stop seams in AppConversationStore, MobileChatRequests, AppRecordSignatures and the existing route/sentinel authorities. This is one bounded review, not six separate review rounds or a convergence result.

The reviewer explicitly performed no runtime implementation or tests. The author separately corrected the prerequisite wording to say the App-link source is still unmerged/unverified and removed the premature single-run-completable claim. Neither correction changes the reviewed identity, stop, recovery or compatibility behavior.

The same reviewer independently read the completed side-effects artifact and concurred with no material omission. It confirmed the prerequisite/readiness disclosures and repeated that no tests ran. This artifact review adds no runtime or convergence assurance.
