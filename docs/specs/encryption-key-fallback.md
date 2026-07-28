---
title: loadEncryptionKey legacy-name fallback (mesh transport setup)
slug: encryption-key-fallback
status: approved
review-convergence: 2026-05-31T09:40:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the standing 12h deploy mandate (topic 13481,
  multi-machine live-transfer cascade). Direct follow-up to #610: the same
  legacy-key-name defect, found live on the mini for the ENCRYPTION key after
  #610 fixed it for the SIGNING key. Flagged per cross-agent discipline.
---

# loadEncryptionKey legacy-name fallback (mesh transport setup)

## Problem

PR #610 (v1.3.151) gave `MachineIdentity.loadSigningKey()` a fallback to the
legacy `signing-private.pem` when the canonical `signing-key.pem` is absent,
because the mini — keyed before the canonical rename — otherwise threw ENOENT at
lease/transport setup and never attached its coordinator.

Deploying #610 to the mini revealed the IDENTICAL defect one layer down:
`loadEncryptionKey()` is canonical-only (`fs.readFileSync(encryptionKeyPath)`),
and the mini had only the legacy `encryption-private.pem`, not the canonical
`encryption-key.pem`. So with the signing key resolved, the mesh lease/transport
setup STILL threw:

```
Lease/transport setup: ENOENT: no such file or directory, open
  '…/.instar/machine/encryption-key.pem'
```

The mesh transport loads BOTH keys (Ed25519 signing for envelope signatures,
X25519 encryption for E2E payload encryption). A legacy-keyed machine resolves the
first and trips on the second — so the transport could not fully initialize on the
mini until the canonical encryption key was provided by hand.

## Goal

A machine whose identity was created before the canonical key rename loads BOTH
its signing and encryption keys without a hand-placed copy, so its mesh transport
initializes cleanly and it can participate in cross-machine lease + session
transfer.

## Non-goals

- No change to key GENERATION (new identities already write the canonical names).
- No open-ended key search — exactly one legacy name (`encryption-private.pem`),
  mirroring the signing-key fallback's single legacy name.
- No change to the wire format, NonceStore, or transport protocol.

## Design

`MachineIdentity.loadEncryptionKey()` mirrors `loadSigningKey()`: read the
canonical `encryption-key.pem`; on ENOENT, fall back to the legacy
`encryption-private.pem` if it exists, else rethrow. A new module constant
`LEGACY_ENCRYPTION_KEY_FILE = 'encryption-private.pem'` sits beside
`LEGACY_SIGNING_KEY_FILE`.

## Testing

- Tier 1 (`machine-identity.test.ts`): `loadEncryptionKey` falls back to the legacy
  name when the canonical is absent; still throws when neither exists. (Mirrors the
  signing-key cases #610 added.) 68 machine-identity tests green; tsc clean.

## Migration parity

Pure code (one constant + one method's catch branch). No config/hook/route/
CLAUDE.md change. Existing agents get it on the v-next update; a legacy-keyed
machine already deployed keeps working (the hand-placed canonical copy is harmless;
the fallback simply means future fresh machines need no hand copy).
