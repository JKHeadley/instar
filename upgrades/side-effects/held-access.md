# Side-Effects Review — asking for access the agent already holds (B17 HELD-ACCESS)

**Version / slug:** `held-access`
**Date:** `2026-11-15`
**Author:** `Echo (instar-dev)`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Echo Bugs topic 10000002770 (2026-11-15, Instar Desktop App topic 143051): after the App Store Connect API key was refused (Developer ID certificates are Account Holder only), Echo asked the operator for his Apple ID password or a manual certificate upload. Echo's vault held that password (`apple_account_…_password`) and the `headley-google` Chrome profile was signed in to that Apple account; the route worked minutes later with no operator step. Traced root gap (confirmed independently by Fable 5.2 and GPT 6 Astra brainstorms, `.instar/lanes/access-already-had-2770/`):

1. The agent-reach data the outbound gate reads listed only browser-profile accounts by their registered service, and deliberately excluded the vault. `headley-google` was registered as `google` only, so `resolve('apple')` returned null and nothing in the reach suggested Apple access.
2. The B17 REACH sub-clause said reach "does NOT cover, and the ask MUST pass: … a secret, 2FA code or CAPTCHA". The Standards Registry's *Never a False Blocker* only allows "a password only the user knows"; the base B17 text says "a password … the agent cannot obtain". The sub-clause contradicted both.
3. The Self-Unblock checklist (which does probe the vault) runs only when the agent settles a blocker, never on an outbound message.

Changes:

- `src/core/agent-reach.ts` — `AgentReachRegistry` gains optional `vaultNames()` and per-account `vaultRefs`/`vaultBindings`. `buildAgentReach` adds per-account `stored` roles (password / code generator / passkey / backup codes, from bindings — role words, never names) and `vaultEntries`: vault NAMES not tied to any account's refs or bindings, sanitized (64), deduped, sorted, capped at `MAX_VAULT_ENTRIES` = 80 with `omittedVaultEntries`. An unreadable or throwing vault → `vaultUnreadable: true`, rendered as "UNKNOWN (not empty)". A registry without `vaultNames` renders exactly as before. Names are packed into lines of at most 200 chars so the gate's per-line belt never cuts one.
- `src/core/PlaywrightProfileRegistry.ts` — public `vaultNames()` (wraps the existing best-effort `safeVaultNames`).
- `src/core/MessagingToneGate.ts` — new exported `B17_HELD_ACCESS_SUBCLAUSE`, rendered in the existing `renderApprovalNotErrand` section (every review except `health-alert`, no phrase pre-filter, reach data still once per prompt). REACH sub-clause carve-out narrowed from "a secret, 2FA code or CAPTCHA" to "a one-time code (2FA, SMS), a CAPTCHA, or a secret the reach does NOT show the agent holding", pointing held-access asks to the new sub-clause. Per-line reach belt 240 → 400 (fields are clamped at build; the belt never cuts decision input). Static template `TONE_GATE_PROMPT_TEMPLATE` byte-identical.
- `src/server/routes.ts` — the outbound review builds reach from `buildPlaywrightRegistry()` (the same per-request registry the `/playwright-profiles` routes use, with the real vault-name lister) instead of a registry whose vault lister returned `[]`. Test override `ctx.playwrightRegistry` still wins.
- `src/data/awareness/access-you-already-hold.md` — awareness entry (no migration needed; feature notes rebuild on update).
- Live data on Echo (not in the diff): `headley-google` now carries an `apple / headley.justin@gmail.com` operator account bound to the vault password, so `resolve('apple')` returns it.

Tier 1 (prompt wording plus wider DATA to an existing LLM rule; a revert fully undoes it; no state, no new authority).

## Decision-point inventory

- `MessagingToneGate B17_FALSE_BLOCKER` — modify — adds a meaning-judged sub-clause and narrows one carve-out.
- Agent-reach context — modify (wider input) — DATA only.
- Awareness entry — guidance text, no decision surface.

---

## 1. Over-block

B17 is blocking and exempt from the advisory migration, so a wrong hold is a hard 422 the agent must rewrite around. Risk cases: (a) a vault name that looks like the service but is stale, rotated or for another account; (b) a browser profile whose session has expired; (c) a genuine "I tried the browser and it failed" ask that does not say so. Mitigations: condition (3) passes any message that names the tried route and how it failed; "a name only suggests a holding" plus the decisive UNDER-FIRE BIAS; PASS for one-time codes, CAPTCHAs and personal device checks; PASS when the reach shows nothing and the ask uses or offers Secret Drop; PASS for permission asks (judged by APPROVAL-NOT-ERRAND). (d) a vault entry for a different account than the one asked about (e.g. the agent's own Apple entry when the ask is about the operator's): condition (2) requires the holding to be for THAT account. (e) an ask the operator explicitly said they would handle themselves: explicit PASS. Secret Drop is offered only as the suggested route, never as a fire condition, because it may be unavailable on an agent with no tunnel. The safe rewrite for every fire is cheap.

## 2. Under-block

The gate sees only text and reach: a sign-in recorded nowhere (only in a memory note), or a vault entry whose name gives no hint of its service, is invisible, and the judge passes by default. The checklist's own vault probe still treats untagged names as "not held" (pre-existing, dark; noted by the Fable brainstorm), so a recorded blocker can still claim exhaustion over unjudged names. The gate catches the outgoing ask, not the missed lookup at the moment of the 403; the awareness entry and the now-registered Apple account address that earlier point by guidance and data only. Paths that bypass the tone gate are not covered (none for operator replies on the standard routes).

## 3. Level-of-abstraction fit

Right layer: the outbound gate is the single authority that judges "hands the user agent-doable work" (B17). This extends B17 in place, in the same dynamic section as APPROVAL-NOT-ERRAND, and feeds it better DATA. No parallel detector: both brainstorms recommended cutting the phrase pre-filter and the message-word matching of vault names, because the judgment of which holding is relevant belongs to the model (an ask for "the Developer ID certificate" never says "Apple").

## 4. Signal vs authority compliance

- [x] Yes — but the logic is a smart gate with full conversational context (LLM-backed).

No brittle logic gains authority. Code decides only which data is shown (all unbound names up to a cap, counted) and which kinds get the section (all but health alerts) — scoping, not judgment.

## 4b. Judgment-point check

No new static heuristic. The 80-name cap limits evidence, never decides meaning, and the omitted count is shown.

## 5. Interactions

- REACH sub-clause: the narrowed carve-out hands held-access asks to the new sub-clause explicitly, so the two cannot contradict.
- APPROVAL-NOT-ERRAND: the new sub-clause defers permission asks to it ("holding access settles CAN, never MAY"), matching the trust journey design (topic 142440): access asks are settled by holdings, permission asks by trust settings and approval cards.
- STANDING-AUTHORIZATION: unchanged; a grant covers a permission ask, not an access ask.
- Prompt size: about 520 tokens of sub-clause plus the vault lines (≤ 80 names × 64 chars ≈ 1.3k tokens worst case) per non-health-alert review.
- Cost per review: `buildPlaywrightRegistry()` decrypts the vault to list names (it already did this for the profile routes; the keychain read is cached by SecretStore). One extra local decrypt per outbound review; fail-open.

## 6. External surfaces

Outbound asks for held access may now be held with a hard 422. Vault entry NAMES now enter the gate's model prompt (the same provider route the gate already uses for message text); values never do. The sub-clause tells the judge never to quote a name in its issue or suggestion, which is the only text returned to the agent. Names can reveal relationships (least revelation): they reach only the gate prompt, not any person-facing or team-member surface. Static template hash unchanged, so the benchmark-divergence detector stays valid.

## 6b. Operator-surface quality

No operator UI. The operator-visible effect: fewer asks for things the agent holds; a genuine credential ask arrives as one Secret Drop link.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: browser profiles live on one disk, and each machine's gate reads its own registry and vault. The question the gate answers is whether THIS agent on THIS machine holds the access. A session on a machine without the profile sees no profile and the judge passes (under-fire), which is the safe direction.

## 8. Rollback cost

A revert restores the old prompt and reach on restart. The awareness paragraph is removed on the next update (entries rebuild). The live registry account on Echo is harmless data and can stay.

## Conclusion

Closes the gap between "what the agent holds" and "the decision to ask", judged by meaning with an under-fire bias, permission left with the trust journey. Safe to ship.

## Second-pass review (if required)

Independent subagent reviewer, 2026-11-15: Concern raised. Checked fine: production wiring passes real vault names (buildPlaywrightRegistry → SecretStore → secretKeyPaths, names only); no TDZ (the review runs per request, after createRoutes initialized the const; a throw would fail open); no value leak; no line reaches the 400-char belt (worst account line about 381, vault lines about 202); bound-name exclusion correct; no contradiction with REACH / APPROVAL-NOT-ERRAND / STANDING-AUTHORIZATION / B21. Concerns: (1) no PASS for "the operator explicitly asked to do it themselves" (REACH has one); (2) the paste-into-chat fire condition fired without any holding and assumed Secret Drop is always available; (3) a vault name only plausibly for the service, not the account, could fire on a different account's entry; (4) the integration test stubbed the registry, so the production vault path was untested; plus missing prompt-text checks for the tried-route PASS and a bindings-only exclusion test.

Fixes applied: (1) explicit PASS added; (2) the paste-into-chat fire condition removed, Secret Drop kept as the suggested route only (asserted: no "Also fire when"); (3) condition (2) now requires the entry to belong to THAT account; (4) three route tests with no override read a real encrypted vault in a temp state dir (names present and value absent, no vault file reads "none", undecryptable vault reads "UNKNOWN"); prompt-text assertions for the tried-route and operator-asked PASS cases; a bindings-only exclusion test. Artifact, release note and overview updated to match.

Re-check 1 (same reviewer): all four fixes confirmed in the code; one concern: the real-vault route tests wrote the vault with a file key but the route config set no `secrets.forceFileKey`, so the read could go through the keychain path. Fixed: `secrets: { forceFileKey: true }` in the real-vault config. Both integration files then passed (2 files, 7 tests, push config).

Re-check 2 (same reviewer): fix confirmed; noted the reader still lists the shared keychain key as a read-only backup after the file key, which is harmless.

Concur with the review

## Evidence pointers

- `tests/unit/held-access-false-blocker.test.ts`
- `tests/integration/telegram-reply-held-access.test.ts`
- `tests/unit/reach-aware-false-blocker.test.ts`, `tests/unit/approval-not-errand.test.ts`, `tests/unit/awareness-entry-registry.test.ts` — still green.

## Class-Closure Declaration (display-only mirror)

The class is "an operator ask for something the agent's own reach already covers". REACH covered look/check errands, APPROVAL-NOT-ERRAND covered decision chores; HELD-ACCESS covers access (credentials, sign-ins, manual uploads), the form the old "a secret must pass" carve-out exempted. The producing side (an unregistered sign-in, an untagged vault entry) is covered by guidance and the live registry fix; the dark checklist's untagged-name behaviour is stated in §2.
