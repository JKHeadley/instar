# Side effects: default model joins the machine-coherence manifest

## What changed
Two rows in `COHERENCE_CRITICAL_FLAGS` (`src/core/machineCoherenceManifest.ts`): `defaultModel.claude-code` and `defaultModel.codex-cli`, read from `sessions.frameworkDefaultModels.<framework>` on the boot config object (the same object `TopicProfileResolver` reads and PATCH /config mutates). The value is the clamped model id, or `account-default` when unset.

## Why
2026-11-09 22:15 UTC, topic 141133: the reply tag "Fable 5.1" was accurate (observed from the transcript). The topic has no pin; Mama PC had no Claude default, so the CLI login default (Fable 5.1) ran, while the Studio and Mac Mini default to Opus 5.5. Nothing compared that setting across machines.

## Review
1. Over-block: none; the guard never blocks. A fleet that deliberately runs different defaults per machine gets an alarm; "leave it" keeps it quiet.
2. Under-block: frameworks other than claude-code and codex-cli are not compared (not in live use here); an unreachable machine (no advert) is not compared, as for every row.
3. Level: the existing cross-machine settings guard is the right layer; no new mechanism.
4. Signal vs authority: signal only, feeds the existing attention item.
5. Interactions: the manifest hash changes, so mixed-version machines see the usual manifest/version skew until all update (same as any manifest row). Default-model rows never auto-propose a fix (`isDefaultModelKey` in `machineCoherenceEpisodeManager.ts`): the majority / lease-holder tie-break can pick "not set" and would propose removing the intended model, and the advertised value is a clamped id (`gpt-6.1-sol` shows as `gpt-6-1-sol`), not a writable one. The alarm lists each machine's model and asks the operator which one to set everywhere.
6. External surfaces: two more keys in the advert (about 90 bytes, inside the 2048-byte budget the manifest test checks).
7. Multi-machine: this is the multi-machine fix; the advert is per machine and compared pool-wide.
8. Rollback: revert; adverts drop the rows within one beat.

## 6b. Operator-surface quality
The attention-item text reads "…aren't running as the same me: the default claude-code model for topics with no model pin" then "They are set to different default models (Mac Studio=claude-opus-5-5, Mama PC=account-default; account-default means nothing is set, so the login's own default runs). Tell me which model you want on all of them and I'll set it on each machine".

Tier 1, 5 source/test files, about 120 lines; one build pass.

## Second-pass review
**Reviewer:** independent subagent (general-purpose)

Concern raised: the fix direction can point at `account-default`. `targetValueClassFor` equalizes toward the majority, or toward the lease holder on a tie. In the 141133 shape (2 machines on Opus 5.5, 2 unset) with Mama PC or the Laptop holding the lease, or whenever most machines are unset, the alarm proposes "switch the default claude-code model ... to account-default on Studio". That removes the Opus default instead of adding it, and a wired `onExecuteFix` would write the literal `account-default` (or a clamped id such as `gpt-6-1-sol`) into `sessions.frameworkDefaultModels`. Nothing breaks today because `onExecuteFix` has no wiring. Still, section 5 should say that the direction can be "unset", and the `defaultModel.*` keys should go into `NEVER_AUTO_PROPOSE_KEYS`, or be mapped to the real unclamped id and to "delete the key", before any fix handler is wired. Other checks passed: readSource `boot` matches `TopicProfileResolver` (`ctx.config`), entry count is 33 of 64, and a worst-case advert with 32-character model ids is about 1556 of 2048 bytes.


**Resolution:** the concern is fixed in this change. Default-model rows are excluded from auto-proposal and render their own decision line (each machine's value, then "Tell me which model you want on all of them"); a test in `tests/unit/machine-coherence-episode-manager.test.ts` covers the tie case the reviewer described.

Re-check after fix: concur.
