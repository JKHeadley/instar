# Side effects: ask for a key and cancel a request from the phone

Change: two owner-phone POST routes on the permission action path, an `actions` field on `GET /mobile/secrets`, two new action kinds, and the app sheet and Cancel buttons.

**Second-pass reviewer:** `codex-cli:gpt-6-astra cross-model rounds (see the convergence report)`

1. **Over-block.** A label or note with a long hex or opaque run is refused, which can hit an honest name such as a long product code. The person rewords it, or uses the console. `already-waiting` refuses a second request with the same name for a different person; the words point to the console and to cancelling.
2. **Under-block.** A password without a recognisable shape can still be typed into the label. The sheet says not to. A console create can still duplicate a name, as it can today.
3. **Level-of-abstraction fit.** Reuses `writeGate`, `proven`, `ActionChallengeStore` and the audit file, not a parallel gate. SecretDrop logic stays beside the read in `mobileSecretsRoutes.ts`.
4. **Signal vs authority.** The gate is deterministic cryptographic proof, unchanged. The new refusals are fixed input rules on the phone's own write, not a judgement over agent behaviour.
5. **Interactions.** Shares the `permission-actions` 12-per-minute bucket with approvals. A Secret Drop made here behaves as a console one: stuck-consumer notices and arrival messages follow `topicId`. With no conversation chosen, nobody is told on arrival, as with the console's "No conversation".
6. **External surfaces.** New: two device routes. `GET /mobile/secrets` gains `actions`. Agent awareness: CLAUDE.md bullet, migration and capability entry. The token and link are never in a phone answer or the audit file.
7. **Multi-machine posture.** Machine-local by design (physical-credential-locality): a request lives on the machine that receives the value. Peer rows stay read-only.
8. **Rollback.** Turn off `mobilePairing.permissionActions` or revert. Requests already made expire within the hour.

## Second-pass review

**Reviewer:** codex-cli:gpt-6-astra (spec rounds) and an independent Claude clean-door read of the code; see `docs/specs/reports/mobile-native-secrets-writes-convergence.md`.
**Independent read of the artifact: concur after fixes.** Codex read the code and found no design fault; the clean-door read found no exploitable hole and two design points, both fixed in the spec and code. That read was not repeated on the fixes.
