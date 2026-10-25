# Side-Effects Review — Witness: registry client commands (publish / lookup / get / stats)

**Version / slug:** `witness-registry-client`
**Date:** `2026-10-25`
**Author:** `Echo`
**Second-pass reviewer:** `not required`
**Tier:** 1 (small, reversible; a revert fully undoes it; no gate, no authority over any agent). Size: 2 new modules, 1 CLI file, 1 index, 1 new test file, README, package.json, docs; about 560 LOC added. Effort: 0 spec rounds (Tier 1, ELI16 + this artifact), 1 commit attempt.

## Summary of the change

`packages/witness` (the standalone `instar-witness` CLI, not Instar server code) gains the client half of the Witness registry agreed with Dawn on 2026-10-25 (thread-3e84d9ed, CMT-998): `witness publish`, `witness lookup`, `witness get`, `witness stats`, against Dawn's routes (`POST /witness/records`, `GET /witness/records?subject|issuer`, `GET /witness/records/:hash`, `GET /witness/stats`; the current default server lives in the one constant `DEFAULT_REGISTRY`, since the registry's home may move; `--registry <url>` to override). New module `localverify.ts` holds the one record-against-binding check (the sequence `witness verify` always ran) so publishing and reading back run the identical check; `verify` now calls it too. New module `registry.ts` is the only networking code: URL vetting (https, or plain http for localhost only), a 15 s timeout, a 4 MiB response cap, Node's built-in fetch, no new dependency, and the pure assessment of a server page (re-verify every record, honour a revocation only when it verifies and comes from the same issuer about the same subject, label everything else the server says as `unverified`). Version 0.1.0 → 0.2.0.

## Decision-point inventory

No decision point about agent behavior or information flow. The verdicts are deterministic checks inside a user-run CLI, and none of them run inside an Instar agent, gate a message or constrain a session:

- `witness publish` — refuse — the record does not verify locally (nothing is sent), or the server's `recordHash` differs from the local one (the record is not treated as published).
- `witness lookup` / `witness get` — label — each returned record is `verified` / `expired` / `failed(reason)`; `revokedBy` is shown only for a verified same-issuer revocation.

---

## 1. Over-block

- `publish` refuses an expired-but-genuine record? No: `verifyRecordWithBinding` returns `ok: true, expired: true` and publish proceeds; the server decides. A record the local check rejects is refused before sending, which is the intended rule.
- A registry on plain `http` that is not localhost is refused. A deliberately non-TLS deployment would be refused too; that is the intended posture for a public network. Tests run on `127.0.0.1`.
- A server whose `recordHash` differs from the one computed here fails the publish and marks a lookup row `failed`, even though the record itself verifies. Deliberate: revocations and `get` are keyed on that id, so a server that mislabels ids would point them at the wrong statement.
- `--limit` above 200 is refused locally rather than sent (the contract's maximum).
- A `get` whose server answer is a genuine record but not the hash asked for is `failed`. Deliberate.

---

## 2. Under-block

- `lookup` and `get` verify against the single binding the server supplies; they do not walk a binding chain, so a record under a superseded or revoked binding still reads `verified` (as `witness verify` does). The README says so; the trial forbids rotation.
- A `did:web` issuer's key cannot be checked offline; `issuerKeyCheck` says so on every such row, as `verify` already did.
- `stats` is unverifiable by construction and is printed as the server's word.
- `revokedBy` requires the revocation to be on the same page (the contract promises that); a revocation held back by a server is simply not honoured, and the server's assertion is reported under `unverified.revocationRefused`.
- Nothing rate-limits the client. The server enforces its abuse limits.

---

## 3. Level-of-abstraction fit

The right layer is the Witness CLI, where records are made and read. The verification sequence lives in one function (`localverify.ts`) that `verify`, `publish`, `lookup` and `get` all call, so the four cannot drift from each other. The page assessment is pure (`registry.ts` exports it without any network), so it is unit-tested with hand-built pages. Nothing in Instar's server consumes it and nothing here should feed a gate because there is no gate.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface over any agent.

The refusals are signature and hash comparisons over data the user handed to a command the user ran. The registry's own verdicts are treated exactly as this principle asks: as signals, re-checked, never as authority. The output structure makes the split explicit (`status` is what this machine checked; `unverified` is what the server said).

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Every check is an invariant (a signature verifies or not; two hashes are equal or not).

---

## 5. Interactions

- **Shadowing:** `verify`'s behaviour is unchanged (same checks, same reason strings, same output fields); it now calls the shared function. Dawn's server returns these same reason strings on 422 because it runs this package.
- **Double-fire:** none; no other code in the package or in Instar talks to the registry.
- **Races:** none; each command is one request.
- **PR #2350 (SealKeeper reference, open, held):** both PRs edit the CLI header comment, the `parseArgs` option list, the `verify` case, the README "Not yet" list and bump the version to 0.2.0. Whichever lands second rebases: `verify` becomes "shared check, then SEAL fields", and the version goes to 0.3.0.

---

## 6. External surfaces

- Other agents: Dawn's registry server (the current default) receives `{record, binding}` on publish. The live test published one real record by Echo about Dawn (hash `83a9000e…`), re-published it (duplicate), and sent one tampered copy by curl (422). Stats now shows two issuers; both are real.
- Install base: Instar agents are unaffected; nothing in `src/` imports the package.
- External systems: merging publishes `instar-witness` 0.2.0 to npm through the existing `publish-witness.yml` workflow (it also patch-bumps if the version already exists).
- Persistent state: none added on disk. `publish` reads two files the user names.
- Timing/runtime: the four commands need network reachability to the registry; failures are named (`could not reach`, `did not answer within`, `response too large`) and exit 1.
- Operator surface: none. "No operator-facing actions."

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The commands act on files the user names and on a remote registry; they create no durable state. The Witness home (`~/.threadline/witness`) is per-machine, as the README's "Not yet" already states for replication. No user-facing notices, no generated URLs, no topic-bound state.

---

## 8. Rollback cost

Pure code change in one package: revert the PR and publish the previous package. Records already published to the registry are its data and are unaffected by the client version. No migration, no agent state repair.

---

## Conclusion

The review confirms the change is a client in a standalone CLI with no authority surface, whose one design rule is that the registry is never trusted: every record is re-verified here and every server assertion is labelled. The one judgment call: a server `recordHash` that does not match the local one marks the row `failed` rather than merely noting the mismatch, because that id is what revocations and `get` are keyed on. Tested against the live server before the PR was opened. Clear to ship.

---

## Second-pass review (if required)

Not required: no messaging, session-lifecycle, gate, sentinel, guard or watchdog surface.

---

## Evidence pointers

- `cd packages/witness && npm test`: 55 pass, 0 fail (17 new tests in `test/registry.test.mjs`).
- The new tests caught a real bug during the build: the first version joined `base.pathname + route` as a relative URL, which for a `/` base became the protocol-relative `//witness/...`; 14 of the 17 new tests failed with `could not reach the registry at http://witness` until the join was fixed.
- Live, 2026-10-25 14:24–14:27 PDT against the current default registry (Dawn's server, at its address of that day): `stats` (1 issuer → 2 after publish); `lookup --issuer <Dawn>` → Dawn's record `75e78852…` verified, `issuerKeyCheck: checked`; `publish` Echo's record → `{ ok, recordHash 83a9000e…, duplicate: false, registered: true }`; re-publish → `duplicate: true`; `get 83a9000e…` → verified; `lookup --subject <Echo>` → Dawn's record led by Dawn's issuer; tampered copy by curl → `422 {"ok":false,"reason":"bad signature"}`; the client refused the same tampered record locally before sending; `get` of an unknown hash → "the registry has no record …", exit 1.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
