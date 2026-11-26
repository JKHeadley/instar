# Side-Effects Review — Witness: SealKeeper's SEAL reference (provisional)

**Version / slug:** `witness-sealkeeper-reference`
**Date:** `2026-10-25`
**Author:** `Echo`
**Second-pass reviewer:** `not required`
**Tier:** 1 (small, reversible; a revert fully undoes it). Size: 1 new module, 1 CLI file, 1 index, 2 test files, README, docs; about 330 LOC added. Effort: 0 spec rounds (Tier 1, ELI16 + this artifact), 1 commit attempt.

## Summary of the change

`packages/witness` (the standalone `instar-witness` CLI, not Instar server code) learns SealKeeper's one-string SEAL reference `sealkeeper:seal:1:<party>:<sha256>:<url>`. New module `src/seal.ts` parses it by splitting on the first five colons only, writes it with the same limits (no colon in the party, https URL, at most 200 characters), and matches SEAL bytes to references by hash. `witness seal-evidence --party --url` emits the form and keeps the SEAL bytes under their hash in the Witness home; `witness export` carries those bytes beside the records and refuses bytes that match no reference; `witness verify --seal <file>` checks bytes against the hash, refuses a mismatch, and reports party and URL as unverified labels. The 0.1.0 form `seal:sha256:<hex>` is still accepted on every path. Every output touching the new form carries a `provisional` note until SealKeeper (Carl) confirms the reading. Agreed with Dawn in Threadline thread-3e84d9ed; CMT-965.

## Decision-point inventory

No decision point about agent behavior or information flow. The only verdicts are two deterministic hash comparisons inside a user-run CLI:

- `witness verify` — modify — `ok:false` when supplied SEAL bytes hash to nothing the record references.
- `witness export` — modify — refuses when supplied SEAL bytes hash to nothing an exported record references, or a stored SEAL no longer hashes to its name.

Neither runs inside an Instar agent, gates a message, or constrains a session.

---

## 1. Over-block

- A SealKeeper party id that contains a colon is refused when writing a reference. Correct by construction: the parser could not tell it from the hash field. This is the one open question with Carl; the README names it.
- A reference over 200 characters is refused on writing and reported `malformed` on reading (Carl's limit). A legitimate long read URL would hit it; that is SealKeeper's rule, not ours.
- `verify --seal` with bytes for a SEAL the record does not reference returns `ok:false`. A user who hands verify an unrelated file sees a refusal with the stray hash named; that is the agreed behavior (a mismatch is refused, not ignored).

---

## 2. Under-block

- Nothing verifies the party or the URL. Deliberate: only the hash is trusted and the output says so. A reference naming the wrong party with the right hash verifies; the verifier sees `unverified: ['party','url']`.
- A malformed `sealkeeper:seal:1:` item is reported in `seals[]` with its reason but does not flip `ok`; `ok` stays the signature verdict. A verifier reading only `ok` misses it; the entry is in the same JSON.
- `verify` without `--seal` cannot check bytes; it reports `bytesChecked:false` rather than failing, so an old record without bytes on hand still verifies as a genuine, unchecked-SEAL record.

---

## 3. Level-of-abstraction fit

The right layer is the Witness CLI, where the SEAL evidence item is produced and read. The parser lives in its own pure module (`seal.ts`) exported from the package index, so a later format change (if Carl's answer on colons comes back) touches one file and its tests. Nothing in Instar's server consumes it; nothing here should feed a gate because there is no gate.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The two refusals are hash comparisons over data the user supplied to a command the user ran; they constrain no agent and filter no message. The parser produces structured data (format, hash, labels, provisional flag) for a human or tool to read.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The hash check is an invariant (bytes match the sha256 or they do not), not a judgment.

---

## 5. Interactions

- **Shadowing:** none. `verify`'s existing checks (binding validity, issuer match, did:key check, signature) run first and unchanged; the SEAL check only adds fields or turns a passing verdict into a refusal on a byte mismatch.
- **Double-fire:** none; no other code reads SEAL references.
- **Races:** `seal-evidence` writes `seals/<sha256>.seal` with `wx` and skips when present; two runs with the same bytes cannot conflict.
- **Feedback loops:** none.

---

## 6. External surfaces

- Other agents: Dawn (and Carl's SealKeeper, through Dawn) consume the emitted reference string and the `export` JSON. The old two-item form still verifies, so records already issued keep working. The new `seals` / `sealsMissing` / `provisional` fields are additions to the export JSON.
- Install base: Instar agents are unaffected; the package is standalone and nothing in `src/` imports it.
- External systems: merging publishes `instar-witness` 0.3.0 to npm through the existing `publish-witness.yml` workflow (it runs on any push touching `packages/witness/**`). The version is bumped in this PR (0.2.0 → 0.3.0, after the registry-client release took 0.2.0: new reference form, new `seals` export fields) so the publish is not refused as a duplicate.
- Persistent state: a new `seals/` directory in the Witness home (`~/.threadline/witness` or `--home`), mode 0700, files 0600, named by hash. Nothing else on disk changes.
- Timing/runtime: none; no network, no clocks beyond what verify already used.
- Operator surface: none. "No operator-facing actions."

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The Witness home is per-machine today (the README's "Not yet" already lists cross-machine replication of records as planned work on `multiMachine.stateSync`); the `seals/` copies sit beside the records they belong to and would ride the same replication when it exists. No user-facing notices, no URLs generated, no topic-bound state.

---

## 8. Rollback cost

Pure code change in one package: revert the PR and publish the previous package. The `seals/` directory a user accumulated is inert to the old CLI (it never reads it). Records that carry the new reference form would read as plain evidence strings to the old CLI (no refusal, no check), exactly as any unknown evidence item does. No migration, no agent state repair.

---

## Conclusion

The review confirms the change is a data-format addition in a standalone CLI with no authority surface. The one design choice it forced: `verify` keeps `ok` as the signature verdict and reports a malformed SealKeeper item in `seals[]` rather than failing the record, so a typo in a label cannot read as a forgery. The provisional marking and the colon question are in the README and in every relevant output. Clear to ship behind the `hold` label pending Justin's confirmation.

---

## Second-pass review (if required)

Not required: no messaging, session-lifecycle, gate, sentinel, guard or watchdog surface.

---

## Evidence pointers

- `cd packages/witness && npm test`: 48 pass, 0 fail (12 new tests).
- With `src/` stashed, the same suite: 6 fail (the 5 new CLI tests plus the unit file), 12 pass, so the tests fail for the right reason without the change.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
