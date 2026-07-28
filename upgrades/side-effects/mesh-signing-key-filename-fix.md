# Side-effects review — mesh signing-key filename fix (the SEND-side break)

## What was happening (real-hardware, 2026-05-30)

After the /mesh/rpc auth exemption (v1.3.104) deployed to BOTH machines, the Mac
mini STILL showed offline on the laptop (the router). The mini→laptop presence
pull worked (the mini's log: `recorded 1 peer(s) online: m_cc2ec651`), but the
laptop→mini direction never fired and the mini never even RECEIVED the laptop's
`session-status` call.

Root cause: the server-boot loader for `localSigningKeyPem` — the private key the
`MeshRpcClient` signs every outbound machine-to-machine command with — hard-coded
the filename `signing-private.pem`. But `MachineIdentity` writes the signing key
as `signing-key.pem` (its `SIGNING_KEY_FILE`). So a normally-created install had
`signing-private.pem` ABSENT → `localSigningKeyPem` stayed `''` → the
`MeshRpcClient` signed with an empty key → the send threw → the machine could NOT
pull presence from / deliver to / transfer to any peer. It still RECEIVED fine,
because the receive path verifies the OTHER machine's key (which it has), not its
own. That produced the exact asymmetry observed: the mini (propagated with the
non-canonical `signing-private.pem`) could send; the laptop (canonical
`signing-key.pem`) could not — two filename bugs lining up.

Confirmed by giving the laptop a `signing-private.pem` copy of its own key +
restarting: the laptop immediately began recording the mini online over HTTP, and
the pool showed both machines online.

## The fix

- **`src/commands/server.ts`** — the loader now reads the CANONICAL
  `signing-key.pem` first, falling back to the legacy/propagated
  `signing-private.pem`, so BOTH layouts load a key. (The lease transport already
  used `idMgr.loadSigningKey()`, which reads the canonical name — only this
  MeshRpcClient loader was on the wrong filename.)

## Blast radius

- **Pure fix to a boot-time read on the multi-machine path.** A single-machine
  agent never constructs a MeshRpcClient, so it is unaffected. A machine that
  already had `signing-private.pem` (propagated) keeps working via the fallback.
  A machine with the canonical `signing-key.pem` (the common case) now loads its
  key and can SEND cross-machine commands — the bug fix.
- **No new config / route / schema / hook / skill → no migration.** Server code;
  existing agents pick it up on the next release. This is the SEND-side companion
  to the /mesh/rpc auth exemption (the receive-side fix) — both were needed for
  the cross-machine pool to function over the wire.
- **Separately, the propagation path should write the canonical `signing-key.pem`**
  (it currently writes `signing-private.pem`); that is a propagation-side cleanup
  tracked separately. This fix makes the loader tolerant of both regardless.

## Tests

- `tests/unit/mesh-signing-key-resolution.test.ts` — the loader reads the
  canonical `signing-key.pem`, tries it BEFORE the legacy `signing-private.pem`
  (fallback order), and the canonical name matches `MachineIdentity.SIGNING_KEY_FILE`.
