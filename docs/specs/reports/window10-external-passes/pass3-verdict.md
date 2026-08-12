# External review pass 3 — reviewer's verbatim final answer

Written 2026-08-09 after review pass 5 ruled that these judgements existed only as the author's
paraphrase and were therefore not independently auditable. That was correct and it is a real defect
in how this window was run: five external verdicts, all reported to the operator in my own words,
none of them on disk. The exploration logs (up to 2MB each) are NOT kept — only the reviewer's final
answer block, verbatim, so a later reader can grade my summaries against the source.

---

```text
FINDINGS —

1. SEVERITY major — Content-addressed freshness is incomplete. The digest covers only text from `**Enforcement fingerprint.**` to the article end. It misses preceding Rule/Applied-through changes, changes to cited guard implementations or tests, and changes to the ENFORCEMENT GAP’s shape or sweep method. Moreover, merely copying the current digest into the JSON—without changing the verdict, reason, evidence, or `sweptAt`—passes. A substantively stale sweep can therefore remain machine-clean.

2. SEVERITY major — “Exact membership” is not exact. The lint catches live fingerprinted articles left in the baseline, but does not reject baseline names absent from the registry. Deleting a grandfathered article passes, leaves a false count, and lets a later same-name article inherit the old exemption.

3. SEVERITY major — The measurement correction was asserted but not completed. `lint-deferral-referent-resolves.mjs` still says “110 pre-existing orphans” and its MEASURED/CERTIFIED block still describes the superseded CMT/ACT population. `docs/enforcement-gaps.json` still asserts 62%, while the ELI16 and side-effects records retain 178/110/62% as operative prose. Tooth E was corrected, but repository truth remains contradictory.

4. SEVERITY major — Deferral’s fingerprint manufactures commit-time coverage. It declares only `ci-time`, explains that the commit-time arm was withdrawn as unreachable for Tier 1, then says writing a deferral is “commit-time, covered.” Those statements cannot all be true.

5. SEVERITY major — The outbound coverage assertions remain unsupported. Sovereignty’s park/ask signals test phrase-selected parking, means, or standing authorization—not ownership of the resource—and carry no ownership context. Self-Unblock’s B16/B17 judgment tests the outbound claim, not whether the required probes actually ran; the article itself admits that missing obligation, and its motivating violation passed the live gate. Refusing an Applied-through citation does not make the favorable coverage assertions evidence-based.

6. SEVERITY major — The gap lint’s claimed malformed/unswept enforcement is bypassable. `countdown` and `sweptAt` are not validated as dates, so an unswept gap with `countdown: "never"` remains green indefinitely. A matched verdict may also use `evidence: true` or `action: true`, repeating the exact truthiness defect fixed for `why` and manufacturing evidence.

7. SEVERITY minor — Namespacing is partial. The data file still begins “The GAP registry,” explicitly defines “a GAP,” and repeatedly uses bare gap/fingerprint terminology; the script headings also retain the bare forms. ENFORCEMENT FINGERPRINT was substituted in places, but the claimed all-three-files correction was not completed.

8. SEVERITY minor — The two lints disagree on what constitutes a fingerprint. The fingerprint requirement uses the full declaration syntax, while the gap lint uses only the phrase `**Enforcement fingerprint.**`; quoted or malformed prose can therefore enter the sweep population while remaining grandfathered by the requirement lint.

Critical severity: empty. Nit severity: empty.

FIX-VERIFICATION —

1 — PARTIAL: content digests exist and detect edits within the hashed suffix, but substantial stale-sweep paths remain invisible.

2 — PARTIAL: stale live exemptions are caught and the baseline is 83 with a reason, but set equality is not enforced.

3 — PARTIAL: tooth E and the leading measurement paragraph changed; stale 110/62% assertions remain.

4 — HELD: the fourth non-certification was added to the registry.

5 — HELD: `why` must now be a string of at least 20 trimmed characters.

6 — PARTIAL: some canonical definitions were namespaced, but bare canonical terminology remains.

8 — HELD: the `Parent:` pseudo-declaration was replaced with an explicit lineage note.

9 — HELD: the executable diagnostic now recommends only referents outside `docs/`.

7 — The abstention is an evasion: referral was legitimate, but retaining favorable, unsupported coverage assertions while awaiting it was not.

COHERENCE —

No. The submitted registry says commit-time coverage was both withdrawn and present, gives incompatible deferral populations, calls a one-sided baseline comparison exact membership, and presents sweep freshness and malformed-record enforcement that the implementation cannot guarantee. The machinery can be green while its constitutional account is stale.

VERDICT —

reject — multiple major overclaims remain, including an asserted pass-2 fix that was only partially made and manufactured enforcement in both the deferral and outbound-gate accounts.
```
