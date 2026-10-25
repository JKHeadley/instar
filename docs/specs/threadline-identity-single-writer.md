---
title: Threadline identity — one writer, validated reads, repair of hex-encoded key files
slug: threadline-identity-single-writer
date: 2026-10-08
author: echo
tracking: ACT-062
parent-spec: threadline-identity-discovery-unification.md
parent-principle: "Verify the State, Not Its Symbol"
parent-principle-fit: "A stored key string is a symbol. Its length after decoding is the state. Two writers disagreed about the symbol and no reader checked the state, so a 48-byte value was offered to the relay as a public key and a log line said 'connected' straight after the rejection."
binding-standards: ["Structure > Willpower", "Know Your Principal — An Unverified Identity Is a Guess", "Observable Intelligence"]
eli16-overview: threadline-identity-single-writer.eli16.md
approved: true
approved-by: "operator standing approval for the agent-comms track — 2026-10-06 18:57, Telegram topic 122413 (“Yes, I approve. Please don’t let me be the bottleneck here.”)"
review-convergence: "2026-10-08T20:50:21.682Z"
review-iterations: 1
review-completed-at: "2026-10-08T20:50:21.682Z"
review-report: "docs/specs/reports/threadline-identity-single-writer-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# Spec — Threadline identity: one writer, validated reads

A bug fix. It adds no feature, no config key, no route and no stored state.

**Terms.** The *legacy file* is `{stateDir}/threadline/identity.json`. The
*canonical file* is `{stateDir}/identity.json`. A *key* here is an Ed25519
public key or private seed; both are exactly 32 bytes. The *client identity
manager* is `src/threadline/client/IdentityManager.ts`, which the relay client
uses.

## Problem (verified against `main` = 890f02396 and live logs, 2026-10-08)

An agent whose first boot had the relay off (the default) can never connect
once the relay is enabled.

1. **Two writers, two encodings.** `HandshakeManager.getOrCreateIdentity`
   wrote the legacy file as `{publicKey, privateKey}` in **hex**, not
   atomically, with the default file mode. It ran from `GET /threadline/health`
   whenever no routing identity resolved (`ThreadlineEndpoints.ts`), and that
   route is polled by every other local agent's `AgentDiscovery`. The client
   identity manager writes the same file in **base64** with a fingerprint.
2. **No reader checked the result.** `loadFromLegacy`, `loadFromCanonical` and
   `migrateFromLegacy` all ran `Buffer.from(value, 'base64')` and used whatever
   came back. 64 hex characters are valid base64 text and decode to **48
   bytes**.
3. **The migration made it permanent.** `migrateFromLegacy` copied the stored
   strings into the canonical file and computed `canonicalId` from the 48-byte
   value. It runs from `createUnifiedTrustSystem`, which runs only when the
   relay is enabled. From then on `loadFromCanonical` wins on every boot and
   the relay answers `Invalid public key — expected raw 32-byte Ed25519, got 48
   bytes after base64 decode`.
4. **The boot log lied.** `server.ts` printed `Threadline: relay connected to
   <host>` unconditionally. It only ever meant "handlers wired". The real
   result is logged by `ThreadlineBootstrap`.
5. **A corrupt file was answered by minting.** The two loaders swallowed every
   error and returned null, so `getOrCreate` wrote a brand-new identity over a
   legacy file it could not parse. A new identity is a new address.

## Design

### 1. One writer

- New module `src/identity/IdentityKeyFile.ts` holds the only raw `fs` write
  for an identity key file (`writeFileAtomicOwnerOnly`: temp file created
  `0600`, `chmod 0600`, `rename`) and the only decoder.
- `HandshakeManager` no longer generates, reads or writes a key file. It asks
  the client identity manager (`getOrCreate()`), so a handshake signs with the
  same key the relay registers. A handshake is a deliberate use of the
  identity and may still create one — through the identity manager, which
  writes base64 and honours the joined-mesh mint refusal.
- `GET /threadline/health` omits **both** `identityPub` and `fingerprint` when
  no routing identity resolves. Reading health never creates an identity.
- **"One writer" is one module, not one process.** The server, each session's
  MCP process and the listener daemon can all run the identity manager at
  once, so the two writes are made safe against each other:
  - *Create* is create-if-absent (`createFileExclusiveOwnerOnly`: temp file,
    then `link(2)`, which fails if the target exists and never replaces it).
    A process that loses the race writes nothing, re-reads the winner's file
    and adopts that identity. Two processes that both found no file end with
    one identity.
  - *Repair* re-reads the file immediately before the rename and writes
    nothing if the bytes are no longer the ones it validated. This **narrows**
    the window in which a repair could write over someone else's change; it
    does not close it, because the re-read and the rename are two system
    calls. What can land in that instant, and what then happens:
    - another repair of the same file — it writes identical bytes, so the
      order does not matter;
    - a deliberate replacement of the file. There are two: the pairing
      installer (`installAgentIdentityFromPairing`), which runs before the
      server first starts, and `CanonicalIdentityManager.create`, which is
      only called when no file exists. Neither runs while a server is loading
      an existing hex file, and a repair happens once per file, ever. If one
      did land in that instant, the repaired old key would replace it. That
      residual is accepted and stated rather than claimed away.
  - No lock file is used. Only the identity modules would take it, the
    replacement writers above would not, and it would need its own stale-lock
    recovery.
- The pairing installer's write now goes through the same
  `writeFileAtomicOwnerOnly`, so the key-file module holds the only raw `fs`
  write of any identity file. The installer still writes the canonical file
  only, never the legacy one.

Consumers of the absent fields, each checked in code:

| Consumer | With the fields absent |
|---|---|
| `AgentDiscovery.pingThreadlineHealth` | Agent listed, `publicKey`/`fingerprint` undefined (both already optional). |
| `AgentDiscovery.verifyAgent` | Returns null: not verified. Already the rule for a missing key. |
| `AgentDiscovery.heartbeatTick` | Reads `response.ok` only. |
| `backupRoutes.checkFingerprintHealth` | `fingerprint-absent` → the relay is used. No local route, no crash. |
| `routes.ts` self-target guard and sender fingerprint | Now read the client identity manager (`get()`), not the legacy file; no identity → the existing fallback (name comparison / project name). |

### 2. Validate on read, repair hex, refuse the rest

`readIdentityKeyFile(path, {repair})` is used by `loadFromLegacy`,
`loadFromCanonical`, `migrateFromLegacy` and `CanonicalIdentityManager.load`:

- A key is valid only if it decodes to **exactly 32 bytes**. For an
  unencrypted file the public key must also be the one the private seed
  derives.
- A value of exactly 64 hex characters is decoded **as hex**. This is not a
  guess: a 64-character all-hex string decodes as base64 to 48 bytes, which is
  never a key, so the two readings cannot both be valid.
- When either key was hex, the file is **rewritten as base64**, atomically,
  `0600`, with the same key material. A legacy-shaped file gains `fingerprint`,
  `x25519PublicKey` and `createdAt` (file mtime). A canonical-shaped file gets
  `canonicalId` and `displayFingerprint` recomputed from the real key when it
  carries them; every other field is kept and none is added.
- Both files are visited on every load, so a poisoned agent has **both**
  repaired on its first boot with this change — relay on or off, because the
  boot path and the health route both call the client identity manager.
- If the repair cannot be written (read-only disk), the decoded key is still
  used for this run and the reason is logged.
- **Anything else invalid makes the reader throw `IdentityFileInvalidError`.**
  The file is left untouched. Nothing is renamed, deleted or minted over it.
  The identity manager records it as `problem` and the boot reports a
  `Threadline.identity` degradation. What the agent then does depends on the
  other file:

  | Canonical file | Legacy file | Identity used | Health fields | Relay | Reported |
  |---|---|---|---|---|---|
  | absent | absent | none (`getOrCreate` mints, create-if-absent) | absent until minted | connects after mint | — |
  | valid | absent, or valid and equal | canonical | present | connects | — |
  | absent or encrypted | valid | legacy | present | connects | — |
  | valid | valid, different key | canonical | present | connects | files disagree (§5) |
  | **unusable** | valid | legacy (today's fallback, kept) | present | connects | degradation: file ignored |
  | valid | **unusable** | canonical | present | connects | degradation: file ignored |
  | **unusable** | absent or unusable | **none**; `getOrCreate` throws | absent | does not connect | degradation: no identity |

  "Hex" is not a row: a hex file is repaired on read and then counts as valid.
- `migrateFromLegacy` builds the canonical file from the decoded bytes, never
  from the stored strings.
- An encrypted canonical file whose public key is hex is refused, not
  repaired: its identifiers and recovery commitment are bound to bytes this
  code cannot check without the passphrase. No production path passes a
  passphrase, and a passphrase migration of a hex file threw before writing,
  so this state is not known to exist.
- No error, log line or degradation text carries key material: only the path,
  string lengths and decoded byte counts.

Degradation: at boot `bootstrapThreadline` reports `Threadline.identity`
through `DegradationReporter` when the identity manager has a `problem`.

### 3. A truthful boot line

`describeRelayBootStatus(host, connectionState, {daemonHandlingRelay})`
(`src/threadline/relayBootStatus.ts`) returns the line `server.ts` prints:
`relay connected to <host>` only when the client's state is `connected`;
otherwise `relay NOT connected to <host> (state: …)`, or a line saying the
listener daemon owns the connection. The bootstrap's own failure line says
`retrying in the background` only when a connection was attempted; with no
usable identity no socket is opened, and it says `NOT retrying`.

### 4. File hygiene

Every identity write path touched (legacy file, canonical file, migration,
repair) and `relay-tokens.json` now go through `writeFileAtomicOwnerOnly`.

### 5. Coherence of the two files

**Invariant:** when the canonical file and the legacy file both hold a usable
identity, it is the same identity (same public key).

- **Check:** every load by the client identity manager compares the two. That
  is every boot and every health poll, so it recurs without a new timer.
- **On disagreement:** one log line per process and, at boot, a
  `Threadline.identity` degradation naming both files. Nothing is rewritten:
  choosing a key is choosing an address, which is the operator's call.
- **Readers agree regardless:** the canonical file keeps precedence inside the
  identity manager, and every in-process reader of the agent's fingerprint
  (health, discovery announce, relay client, handshake, the `relay-send`
  self-target guard and sender fingerprint) now goes through that manager. No
  reader parses the legacy file on its own any more.

## What it does not do

- It does not change which file wins (canonical, then legacy), the key
  formats on the wire, or the relay.
- It does not pick a winner between a legacy file and a canonical file that
  hold two different valid keys (see "Coherence of the two files").
- It does not change `CanonicalIdentityManager.create()` (it replaces, and is
  only called when no canonical file exists), nor which canonical files
  `CanonicalIdentityManager.load()` accepts: a file with no declared
  `privateKeyEncryption`, the shape the pairing installer writes, is refused
  there exactly as before.
- It does not convert the other modules that read a public key straight from
  the canonical file (`AspKeyDirectory`, the ASP helpers in `routes.ts`,
  `AgentServer`, `TelegramOriginBoot`). They read base64, which is what the
  file holds once boot has repaired it.

## Decision points touched

| Decision point | Class | Floor + arbiter |
|---|---|---|
| Is a stored key usable | invariant | Exactly 32 bytes after decoding; public key matches the private seed. Deterministic, no judgment. |
| Hex or base64 | invariant | Exactly 64 hex characters → hex. Closed rule; the alternative reading is never a valid key. |
| Mint a new identity | invariant | Only when no identity file exists (and the joined-mesh guard allows). Never when a file exists but is unusable. |
| Boot line says "connected" | invariant | Only when `connectionState === 'connected'`. |
| The two files disagree | invariant | Always reported (log + degradation), never auto-resolved; the canonical file keeps precedence. A fixed rule, no judgment. |

## Multi-machine posture

The agent **identity** is `unified`: one key per agent, carried to a joining
machine by the sealed pairing handover
(`agent-identity-continuity-on-expansion.md`). This spec does not change that
and replicates nothing new.

The surface this spec touches is each machine's **on-disk copy of the private
key file**, and that copy is machine-local:

machine-local-justification: physical-credential-locality prohibited-by="protected trust-anchor rule (machine-self-assertion.md): private key files never ride the ordinary file or state sync path; only the sealed pairing handover moves an identity" permanence=permanent

- **The repair is per machine and needs no coordination.** Each machine
  repairs its own copy the first time it loads it. The repair is a pure
  function of the bytes (hex → the same 32 bytes → base64), so two machines
  holding the same poisoned identity converge on the same key and the same
  fingerprint with no message between them.
- **No user-facing notice** is added, so there is nothing to gate to one
  voice. The degradation for an unusable file is per machine because the file
  is.
- **Handover:** `readAgentIdentityForHandover` ships the stored strings. A
  poisoned source machine is repaired at its own boot (before any pairing
  route can run), so it hands over base64. If a hex pair did reach a joiner,
  the joiner's first load repairs it the same way.
- No durable state, URL or topic binding is added.

## Frontloaded Decisions

1. **Repair in place, with no backup copy.** The rewrite holds the same key
   bytes, so nothing is lost, and a second copy of a private key on disk is a
   cost with no benefit.
2. **An unusable file is never moved, deleted or replaced.** If the other
   file holds a usable identity the agent runs on that one and reports the
   ignored file; if not, it stays off the relay and says why (the table in
   §2). Setting a file aside is the operator's choice.
3. **A handshake may still create an identity; health may not.** Health is
   polled by other agents; a handshake is this agent acting.
4. **Health omits `identityPub` as well as `fingerprint`.** A key with no
   routing identity behind it is the "dead address" the parent spec forbade.
5. **The public key must match the private seed.** A mismatched pair cannot
   authenticate to the relay anyway; refusing it at load names the cause.
6. **No lock file.** Create-if-absent closes the create race outright. The
   repair's remaining window is stated in §1 and accepted.
7. **Shipped ungated.** See the maturation plan.

## Open questions

*(none)*

## Migration parity

No config default, hook, template section, skill or state schema changes. The
repair itself is the migration for existing agents and runs on the first load
after update; it is idempotent (a base64 file is read and left byte-for-byte
alone).

## Agent awareness

No template change. The CLAUDE.md template already says "If
`/threadline/health` returns no `fingerprint`, I have no resolvable routing
identity yet", and points at `relay.state` for connection truth. Both stay
correct; the boot line now agrees with them.

## Rollback

Revert the commit. What is and is not guaranteed for a repaired agent running
the previous code:

- **Relay identity: works.** The previous `loadFromCanonical` and
  `loadFromLegacy` read base64, which is what a repaired file holds. This is
  the path the fix exists for, and it is strictly better than before the fix.
- **Local HTTP handshake (`/threadline/handshake/*`): does not work.** The
  previous `HandshakeManager` reads the legacy file as hex, so on a base64
  file it holds an unusable key. That is not a new limitation: it was already
  the state of every agent whose legacy file was written by the relay client.
  The roll-forward fixes it; a rollback returns to it.
- No data is lost either way: the repair never changes key bytes.

There is no config switch: a switch that re-enables the hex writer would only
re-create the defect.

## Tests

- **Unit** — `tests/unit/identity/IdentityKeyFile.test.ts`: decoder both sides
  (base64, hex, wrong lengths, non-keys), mismatched pair, no key material in
  errors, repair-write failure; client identity manager with a hex legacy
  fixture and with a hex canonical fixture (same key, the fingerprint the hex
  key implies, base64, `0600`, idempotent); `CanonicalIdentityManager.load` on
  a poisoned canonical file; `migrateFromLegacy` from a hex legacy file, with
  and without a passphrase; unusable files refused and untouched.
  `tests/unit/threadline/identity-single-writer.test.ts`: a source scan that
  fails if any module but the key-file module writes an `identity.json`
  (proven to flag the removed writer), `HandshakeManager` uses the one
  identity and writes none, the boot-line function, and `server.ts` wiring.
  `tests/unit/threadline/identity-create-race.test.ts`: a forced interleaving
  of two creators (one mints while the other is mid-mint) ends with one
  identity on disk and in both processes.
- **Integration** — `tests/integration/threadline/identity-single-writer-health.test.ts`:
  the real health route on a real port; no identity → fields absent, nothing
  created, `AgentDiscovery` ping/verify and `checkFingerprintHealth` cope; a
  poisoned agent → both files repaired and the right key advertised; an
  unusable file alone → fields absent, file untouched; an unusable canonical
  file beside a valid legacy file → the legacy identity is advertised and
  verifiable, the bad file untouched.
- **E2E** — `tests/e2e/threadline/identity-single-writer-lifecycle.test.ts`:
  `bootstrapThreadline` + a real `RelayServer`: relay off → health polled →
  relay on → the key offered to the relay is 32 bytes and the fingerprint
  equals health's, and the next boot keeps the address; an already-poisoned
  agent connects with the fingerprint its hex key implies; no "connected"
  line when `connect()` was rejected.

## Maturation plan

- **test-agent-live:** the E2E lifecycle test is the throwaway agent: a real
  bootstrap against a real in-process relay, on both the fresh path and the
  already-poisoned path.
- **dev-agent-live:** on merge the development agent (Echo) updates. Its own
  identity files are the live case: both are poisoned today and the relay
  rejects it. Pass = `logs/server.log` shows the repair line for each file,
  `Threadline: relay connected (fingerprint: …)`, and `GET /threadline/health`
  reports `relay.state: connected` with the same fingerprint.
- **fleet:** ships to every agent in the same release, ungated. A fix that
  repairs a permanent failure cannot be dark: a dark repair leaves every
  poisoned agent off the relay, and a flag that keeps the hex writer alive
  keeps creating them. The change is inert for a healthy agent (a base64 file
  is read and left untouched).
- **graduation criterion:** the dev-agent-live pass above, observed once on
  the live agent after the release that carries this change. A zero
  observation is not a pass.
- **dark-window:** none (0 days) — ungated bug fix. Rollback is a revert,
  which is safe because repaired files are valid for the previous code.
