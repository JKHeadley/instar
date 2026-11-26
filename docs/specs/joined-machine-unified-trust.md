---
title: Unified trust initialises on a machine that joined via pairing
slug: joined-machine-unified-trust
date: 2026-10-09
author: echo
tracking: ACT-072
parent-spec: threadline-identity-single-writer.md
parent-principle: "Verify the State, Not Its Symbol"
parent-principle-fit: "A missing `privateKeyEncryption` field is a symbol. Whether the stored private key is a usable plaintext seed whose public key matches is the state, and the reader already checks it. Refusing a verified plaintext pair because a label is absent judged the symbol over the state."
binding-standards: ["Structure > Willpower", "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions", "Know Your Principal — An Unverified Identity Is a Guess"]
eli16-overview: joined-machine-unified-trust.eli16.md
approved: true
approved-by: "operator standing approval — 2026-10-08 14:49 (“Yes, you have my approval to proceed on this without asking for further approval”)"
review-convergence: "2026-10-09T13:24:07.781Z"
review-iterations: 1
review-completed-at: "2026-10-09T13:24:07.781Z"
review-report: "docs/specs/reports/joined-machine-unified-trust-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Spec — Unified trust initialises on a machine that joined via pairing

A bug fix. It adds no feature, no config key, no route and no stored state.

**Terms.** The *canonical file* is `{stateDir}/identity.json`. The *installer*
is `installAgentIdentityFromPairing` (`src/core/AgentIdentityHandover.ts`),
which writes the agent identity on a machine joining an existing mesh. The
*loader* is `CanonicalIdentityManager.load()` (`src/identity/IdentityManager.ts`).

## Problem (verified against `main` = 5eea91f15, i.e. before this change)

1. The installer writes the canonical file as
   `{version: 1, publicKey, privateKey, createdAt, provenance}`. The private
   key is the agent's plaintext 32-byte Ed25519 seed, base64 — it is the same
   string `readAgentIdentityForHandover` read from the source machine and
   sealed to the joiner. There is no `privateKeyEncryption`, `canonicalId` or
   `displayFingerprint` field.
2. The loader dispatches on `privateKeyEncryption`: `'none'` → plaintext,
   `'xchacha20-poly1305+argon2id'` → decrypt, anything else →
   `throw new Error('Unknown encryption method: undefined')`.
3. `createUnifiedTrustSystem` (`src/threadline/UnifiedTrustWiring.ts`) calls
   the loader whenever the canonical file exists. At boot
   (`src/commands/server.ts`) the throw is caught and logged as
   `Unified trust system init failed (non-fatal)`, and `unifiedTrust` stays
   null. So on every machine that joined via pairing the unified trust layer
   (authorization policy, trust audit log, invitations, MoltBridge identity)
   never starts.
4. PR #2150 (ACT-062) left this unchanged and pinned it with the unit test
   "CanonicalIdentityManager.load keeps refusing a file with no declared
   encryption", stating that widening it was a separate decision. This spec is
   that decision.

The rest of the codebase already reads an absent field as "not encrypted":
`readIdentityKeyFile` (`encrypted` is true only for a string other than
`'none'`), `TelegramOriginBoot` and the window send-time guard in `routes.ts`.
The loader is the one reader that disagrees.

## Design

One change, in the loader, and nothing on disk.

1. **An absent `privateKeyEncryption` means `'none'`.** The test is the key's
   absence (`!('privateKeyEncryption' in raw)`), not a falsy value: a field that
   is present but `null`, empty or an unknown string is still refused. The
   error is `Unknown encryption method` when the key material itself is valid;
   if the key fails validation first, the shared reader throws
   `IdentityFileInvalidError` instead. Either way nothing loads.
2. **This is safe because the reader already validated the key.** For a file
   with no declared encryption, `readIdentityKeyFile` requires the private key
   to decode to exactly 32 bytes and its derived public key to equal the stored
   public key. A ciphertext, a truncated key or a mismatched pair is refused
   there with `IdentityFileInvalidError`, before the loader branch runs, and the
   file is left untouched. So the widening can only admit a verified plaintext
   key pair.
3. **Derive the missing identifiers.** `canonicalId` and `displayFingerprint`
   are pure functions of the public key (`computeCanonicalId`,
   `computeDisplayFingerprint`). When absent or empty they are computed in
   memory. A non-empty stored value is used as before (unchanged behaviour).
4. **No new write.** The only write the loader can make is the existing hex
   repair from ACT-062 (a key pair stored as hex is rewritten as base64, same
   key bytes), which runs before the branch above for any file, including one
   that is then refused. For the installer shape that repair adds no field.
   This change adds no write. A base64 installed file is not rewritten, so the installer,
   the handover reader and the relay-side identity manager all keep seeing the
   bytes they see today.

### Why the loader and not the installer

Changing the installer to write the canonical shape would fix new joins only;
every machine that already joined would still need a migration that rewrites a
private-key file. Accepting the shape in the loader fixes new and existing
joined machines with no migration and no extra write of a private key. It also
matches what every other reader already assumes.

## What it does not do

- It does not change the installer, the handover envelope, or which file wins.
- It does not change how an encrypted identity loads.
- It does not carry recovery data. The handover payload is
  `{publicKey, privateKey, createdAt}` plus provenance, so a joined machine has
  no `recoveryCommitment` / `recoverySalt` and recovery-phrase rotation is not
  available there. That was true before this change and is unaffected by it.
- It does not make an encrypted source identity transferable by pairing. The
  handover ships the stored private-key string; if the source were
  passphrase-encrypted the joiner would receive ciphertext with no encryption
  field, and the reader refuses it (point 2). That refusal is the correct
  outcome for this change. No agent runs with an identity passphrase today
  (boot passes none).

## Decision points touched

| Decision point | Class | Floor + arbiter |
|---|---|---|
| Does the loader accept a canonical file with no declared encryption | invariant | Accept only when the field is absent AND `readIdentityKeyFile` has validated a 32-byte plaintext seed whose public key matches. Deterministic; no judgment. A present-but-unknown value is refused. |

## Multi-machine posture

The agent identity is `unified`: one key per agent, carried to a joining
machine by the sealed pairing handover
(`agent-identity-continuity-on-expansion.md`). This change is what lets the
joined machine actually USE that unified identity for unified trust; before,
the source machine ran unified trust and the joiner did not, so the two
machines of one agent disagreed about whether the trust layer existed.

The surface touched is each machine's reading of its own canonical file, which
is machine-local:

machine-local-justification: physical-credential-locality prohibited-by="protected trust-anchor rule (machine-self-assertion.md): private key files never ride the ordinary file or state sync path; only the sealed pairing handover moves an identity" permanence=permanent

- Each machine loads its own copy; the derivation is a pure function of the
  public key, so every machine holding the agent identity computes the same
  `canonicalId` and `displayFingerprint` with no coordination.
- No user-facing notice, durable state, URL or topic binding is added.
- With MoltBridge enabled, a joined machine now initialises MoltBridge with the
  same agent identity as the first machine, as one unified agent should. That
  is the behaviour the first machine already had; MoltBridge is off by default.

## Frontloaded Decisions

1. **Loader, not installer** (see Design). No migration needed.
2. **Absent, not falsy.** Only a missing field means plaintext; a present
   `null` stays an error, so a damaged label is not silently reinterpreted.
3. **No rewrite of the file on load.** Writing a private-key file is a cost
   with no benefit when the identifiers are derivable.
4. **Shipped ungated.** A repair of a permanent failure cannot be dark.

## Open questions

*(none)*

## Migration parity

No config default, hook, template section, skill or state schema changes.
Already-joined machines are fixed by the new loader on their next boot; there
is nothing to migrate.

## Agent awareness

No template change: no new capability, route or trigger. The boot log line
`Unified trust system initialized (identity: <fingerprint>)` now appears on a
joined machine instead of the `init failed` line.

## Rollback

Revert the commit. The previous loader refuses the installer shape again
(the state before this fix). This change rewrites no file, so nothing on disk
needs repair either way (the pre-existing hex repair writes the same key bytes
and is valid for both versions).

## Tests

- **Unit** — `tests/unit/identity/IdentityKeyFile.test.ts`: the pinned
  "keeps refusing" test is replaced by: installer shape loads as plaintext with
  derived identifiers and the file unchanged (and the relay-side manager agrees
  on the fingerprint); the same shape stored as hex is repaired and then
  loads with derived identifiers and no field added; an empty `canonicalId` is
  derived; a declared unknown method, a declared `null` and a declared empty
  string are refused; an installer-shaped file whose private key is not a 32-byte seed
  is refused and untouched; a mismatched pair is refused.
- **Integration** — `tests/integration/joined-machine-unified-trust.test.ts`:
  a real canonical identity on a source dir → `readAgentIdentityForHandover` →
  `sealIdentityForJoiner` → the real installer write on a joiner dir →
  `createUnifiedTrustSystem` on the joiner. Pass = no throw, the loaded identity
  has the source's public key, `canonicalId` and `displayFingerprint`, the file
  is byte-identical, and a signature made with the loaded private key verifies
  against the source public key. The malformed side: an installer-shaped file
  with a non-seed private key makes `createUnifiedTrustSystem` throw
  `IdentityFileInvalidError` and leaves the file untouched.
- **E2E** — no route is added, so there is no new "feature is alive" HTTP
  surface. The integration test is initializer coverage: it drives the same
  production init function (`createUnifiedTrustSystem`) that `server.ts` calls,
  on the file the real installer wrote. It does not boot `server.ts`; the boot
  outcome on a real joined machine is the dev-agent-live observation in the
  maturation plan, which is the release check.

## Maturation plan

- **test-agent-live:** the integration test is the throwaway joiner: real
  seal, real installer write, real unified-trust init.
- **dev-agent-live:** any instar machine that joined via pairing logs
  `Unified trust system initialized` on its first boot after the release.
  A zero observation is not a pass.
- **fleet:** ungated, same release. Inert for a machine whose canonical file
  declares its encryption (every minted identity does).
- **graduation criterion:** the dev-agent-live observation above, seen once
  on a real joined machine after the release that carries this change.
- **dark-window:** none (0 days) — ungated bug fix; rollback is a revert.
