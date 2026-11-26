# Side-Effects Review — Threadline identity: one writer, validated reads

**Version / slug:** `threadline-identity-single-writer`
**Date:** `2026-10-08`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

Spec: docs/specs/threadline-identity-single-writer.md (one review round; approved under the operator's standing approval for the agent-comms track, 2026-10-06 18:57, topic 122413). Tracking: ACT-062. Tier 2 (identity keys are a safety surface; the change repairs files on every agent).

## Summary of the change

An agent whose first boot had the relay off could never connect once the relay was enabled: `HandshakeManager` wrote `threadline/identity.json` in hex (triggered by other agents polling `/threadline/health`), every reader decoded it as base64 without a length check (64 hex characters → 48 bytes), and the migration copied the bad strings into the canonical `identity.json`, which then won on every boot.

- **`src/identity/IdentityKeyFile.ts` (new)** — the only decoder and the only raw `fs` write for an identity key file: `decodeKey32`, `derivePublicKey`, `readIdentityKeyFile` (validate; repair hex → base64 in place), `writeFileAtomicOwnerOnly`, `createFileExclusiveOwnerOnly`, `IdentityFileInvalidError`.
- **`src/threadline/client/IdentityManager.ts`** — both loaders go through the validating reader; both files are visited on every load; fingerprint and X25519 key are derived, never taken from the file; minting is create-if-absent and adopts a concurrent winner; an unusable file sets `problem` and makes `getOrCreate()` throw instead of minting; `identityFilesDisagree` when the two files hold different valid keys.
- **`src/threadline/HandshakeManager.ts`** — no longer generates, reads or writes a key file; takes the key from the client identity manager. `relay-tokens.json` is now written atomically, `0600`.
- **`src/threadline/ThreadlineEndpoints.ts`** — health omits `identityPub` and `fingerprint` when no routing identity resolves; it never mints.
- **`src/identity/Migration.ts`, `src/identity/IdentityManager.ts`** — migrate from decoded bytes; `load()` validates and repairs; writes go through the shared primitive.
- **`src/core/AgentIdentityHandover.ts`** — the pairing installer's write uses the shared primitive (behaviour unchanged: atomic, `0600`, canonical file only).
- **`src/server/routes.ts`** — the `relay-send` self-target guard and sender fingerprint read the identity manager instead of parsing the legacy file.
- **`src/threadline/ThreadlineBootstrap.ts`** — reports a `Threadline.identity` degradation for an unusable file and for two files that disagree.
- **`src/threadline/relayBootStatus.ts` (new) + `src/commands/server.ts`** — the boot line reports the client's real connection state.

No config key, route, hook, template section or state schema is added.

## Decision-point inventory

- Is a stored key usable — **add** — invariant: exactly 32 bytes after decoding; public key matches the private seed.
- Hex or base64 — **add** — invariant: exactly 64 hex characters → hex.
- Mint a new identity — **modify** — invariant: only when no identity file exists; never over an unusable file; create-if-absent.
- Boot line says "connected" — **modify** — invariant: only when the client state is `connected`.
- The two files disagree — **add** — invariant: always reported, never auto-resolved.

---

## 1. Over-block

- A legacy or canonical file that the old code tolerated but that is not a valid identity is now refused: a public key that does not belong to the private key, or a key that is not 32 bytes. Such an identity could not authenticate to the relay before either (the relay verifies a signature against the offered public key), so nothing that worked stops working. What changes is that the cause is named at load.
- A corrupt legacy file used to be silently replaced by a new identity. It is now left in place and the agent stays off the relay until the operator acts. That is the intended trade: the old behaviour changed the agent's address without telling anyone.
- A file in base64url or without padding still loads (the decoder accepts any base64 text that yields 32 bytes).
- No issue identified beyond these.

## 2. Under-block

- Two different **valid** identities in the two files are reported, not resolved. The canonical one stays in use.
- A passphrase-encrypted canonical file with a hex public key is refused rather than repaired. Not known to exist: no production path passes a passphrase, and a passphrase migration of a hex file threw before writing.
- The repair's re-read narrows but does not close the window in which a deliberate replacement of the file could be overwritten (two system calls). The writers that could land there are named in spec §1; none runs while a server loads an existing hex file.
- `readAgentIdentityForHandover` still ships the stored strings without validating them. A poisoned source is repaired at its own boot first; a hex pair that did reach a joiner is repaired on the joiner's first load.
- The source-scan test is a heuristic: it follows one hop of assignment and known `fs` function names (including aliased imports). A write through a function-valued variable is invisible to it, which is why the pairing installer was moved onto the shared primitive rather than left for the scan to catch.

## 3. Level-of-abstraction fit

The validation sits in the reader every identity consumer already goes through, below both identity managers, so no caller can skip it. The write primitive sits in the same module. `HandshakeManager` was the wrong layer to own a key file at all; it now depends on the identity manager, which is the direction the parent spec (`threadline-identity-discovery-unification`) already took for health and discovery.

## 4. Signal vs authority compliance

No blocking authority over messages, sessions or dispatch is added. The checks are deterministic invariants on key bytes (length, key-pair match), not brittle judgments about content. The refusal to mint is a refusal by the identity manager to act on its own, surfaced as a degradation; the two-files-disagree check is a pure signal. Compliant with `docs/signal-vs-authority.md`.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment-shaped decision point. Every rule is a closed, deterministic test (spec "Decision points touched": all invariant).

## 5. Interactions

- **Joined-mesh mint refusal** (`IdentityNotProvisionedError`) still runs in `getOrCreate`, after the new "unusable file" check. A handshake on a joined machine with no identity now throws that error instead of minting a hex file — the guard used to be bypassed by `HandshakeManager`.
- **Listener daemon** constructs `new IdentityManager(stateDir/threadline)`, so it reads the legacy file through the canonical-file loader. The repair keys on the file's content shape, not its path, so a hex file there is repaired to the legacy shape.
- **MCP stdio process and server** can load at the same time: concurrent repairs write identical bytes; concurrent mints resolve to one identity (create-if-absent).
- **Relay tokens** are derived per pair with a salt from both identity public keys. A repaired agent keeps its key, so stored tokens stay valid. An agent whose legacy file was base64 had an unusable handshake key before this change (the old reader decoded it as hex); its handshakes now use the real key, so local HTTP handshakes start working for it.
- **Health polling** now performs a one-time repair write on a poisoned agent. It is idempotent, and boot does it first.
- **`backupRoutes` fingerprint branch**: absent fingerprint → `fingerprint-absent` → relay. Unchanged code, now reachable for an identity-less agent.
- **Degradation reporter**: `Threadline.identity` is a new feature label; reported once per boot.

## 6. External surfaces

- `GET /threadline/health` (unauthenticated, read by other local agents): `identityPub` is now absent when no routing identity resolves. Before, it carried a freshly minted hex key that nothing routed to. `AgentDiscovery.verifyAgent` already returned null for a missing key.
- Boot log: `Threadline: relay connected to <host>` is printed only when connected; otherwise `relay NOT connected to <host> (state: …)` or the listener-daemon line. Anything that greps the old line for liveness now gets the truth.
- New log lines `[identity] … stored its keys as hex; rewrote it as base64` and `[identity] Identity file … cannot be used: …`, each once per process per file. They carry the path, string lengths and decoded byte counts. No key material appears in any log, error or degradation; a unit test checks the error text.
- On disk: hex identity files become base64; file modes become `0600`. No relay protocol change.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface is added. The degradation text names the file and the consequence in plain words.

## 7. Multi-machine posture (Cross-Machine Coherence)

The agent identity stays unified (one key per agent, moved only by the sealed pairing handover). The surface touched is each machine's on-disk copy of the private key file, which is machine-local by the protected trust-anchor rule (spec marker: `physical-credential-locality`, permanent). Each machine repairs its own copy on first load; the repair is a pure function of the bytes, so machines holding the same poisoned identity converge on the same key and fingerprint without talking. No user-facing notice, URL, topic binding or durable state is added. The degradation is per machine because the file is.

## 8. Rollback cost

Revert the commit; no data migration. A repaired file is valid base64 that the previous relay path reads correctly, so a rolled-back repaired agent still connects. Under the previous code the local HTTP handshake reads the legacy file as hex again and does not work on a base64 file — the state every relay-first agent was already in. Key bytes are never changed, so nothing needs repair after a rollback.

## Conclusion

The build follows the spec. It ships ungated because it repairs a permanent failure and is inert for a healthy agent (a base64 file is read and left byte-for-byte alone). Clear to ship.

## Evidence pointers

- `tests/unit/identity/IdentityKeyFile.test.ts` — decoder both sides; write primitives; refusal cases with the file untouched; no key material in errors; repair-write failure; client identity manager on a hex legacy fixture and on a hex canonical fixture; the two-files-disagree signal; `CanonicalIdentityManager.load` on a poisoned file; `migrateFromLegacy` from a hex file with and without a passphrase.
- `tests/unit/threadline/identity-single-writer.test.ts` — source scan (proven against the removed writer and an aliased import), importer list, pairing installer writes canonical only, `HandshakeManager` behaviour, boot-line function and `server.ts` wiring.
- `tests/unit/threadline/identity-create-race.test.ts` — forced interleaving of two creators.
- `tests/integration/threadline/identity-single-writer-health.test.ts` — real health route on a real port with real `AgentDiscovery` and `checkFingerprintHealth`.
- `tests/e2e/threadline/identity-single-writer-lifecycle.test.ts` — `bootstrapThreadline` against a real `RelayServer`: fresh path, already-poisoned path, rejected and unreachable connects.

## Class-Closure Declaration (display-only mirror)

No self-triggered controller and no agent-authored-artifact defect — not applicable. The class closed here is "two writers of one file with no validated read": the scan test fails if a second raw writer of an identity file appears.

## Second-pass review

**Reviewer:** independent reviewer subagent (read the diff and the code; ran no tests)
**Independent read of the artifact: concur**

Concur — no blocking findings. Confirmed: the hex rule and the repair (fields preserved, atomic, `0600`, lengths and path only in errors); every call site that can now receive a thrown identity error catches it (handshake hello route, MCP stdio entry, unified-trust init, bootstrap connect); health consumers tolerate absent fields (`AgentDiscovery`, `dashboard/mandates.js`); signal-vs-authority respected; the listener daemon's path trick works because the repair keys on file shape.

Non-blocking findings and what was done:

1. *The "retries in the background" wording was untrue when there is no usable identity* (no relay socket is ever opened). **Fixed:** the bootstrap line now says `NOT retrying: there is no usable identity…` in that case, and the boot line no longer claims a retry. E2E asserts both wordings.
2. *A canonical file written by the pairing installer (no `privateKeyEncryption` field) would have started loading in `CanonicalIdentityManager.load`, where it used to throw `Unknown encryption method`* — starting unified trust on joined machines for the first time, with untraced downstream effects. **Fixed by not changing it:** that branch is restored and pinned by a unit test. The underlying condition (unified trust does not initialise on a joined machine) predates this change and is reported to the operator as a separate finding.
3. *`writeFileAtomicOwnerOnly` could leave its temp file behind on a failed `chmod`/`rename`.* **Fixed:** the temp file is removed on failure.
4. *The decoder refused a key string with stray whitespace that the old lenient decoder accepted.* **Fixed:** whitespace is ignored; unit test added.
5. *Statements in this artifact were broader than the code.* **Corrected here:**
   - "Minting is create-if-absent" holds for the client identity manager. `CanonicalIdentityManager.create()` (called from `createUnifiedTrustSystem` only when no canonical file exists and no legacy file can be migrated) writes by replace and does not consult the joined-mesh refusal. Unchanged by this change.
   - An encrypted canonical file is "not loadable here" for the client manager, so with no legacy file `getOrCreate()` still mints a legacy identity beside it. Unchanged; reachable only if a passphrase is ever used.
   - Where the two files hold two different valid keys, the local handshake key moves to the canonical one (it used to be whatever the hex reader made of the legacy file), and the listener daemon, which reads the legacy file first, uses the legacy key. The `Threadline.identity` "files disagree" degradation fires at every boot in that state.
   - Other modules still read the canonical `identity.json` directly as base64 for a public key (`routes.ts` ASP helpers, `AgentServer.ts`, `AspKeyDirectory.ts`, `TelegramOriginBoot.ts`). They are correct once the file is repaired, and boot repairs it before they run; they are outside the single-decoder claim, which covers the identity managers and the migration.

Not checked by the reviewer: the relay's signature verification, relay-token validation, the test files, `KeyRotation.ts`.

## Deviations from the spec text (recorded)

- `CanonicalIdentityManager.load` validates and repairs as the spec says, but keeps refusing a file with no declared `privateKeyEncryption` exactly as before (second-pass finding 2).
