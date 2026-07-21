## What Changed

- Added dedicated, permission-hardened Ed25519 client and host identities under
  Instar state, with idempotent first boot and corruption-driven generation rotation.
- Added an exact-pinned `ssh2` restricted endpoint that accepts only leased paired-
  machine keys and the `instar-rpc` subsystem; shell, exec, PTY, SFTP, forwarding,
  passwords, public binds, oversized frames, and stale identities are refused.
- Added pinned, source-local directional challenge proofs, strict A→B plus B→A
  mutuality, bounded repair/breaker control, dry-run-first dev gating, and the
  scrubbed `/machines/ssh-health` read surface.

## Evidence

- Real transport fixtures prove both directions using separate OS child processes,
  machine identities, endpoints, admissions, host-key pins, and client keys.
- Unit coverage exercises keyless boot, corrupt-key rotation, epoch/generation
  fencing, cross-identity key collision, stale/public advert refusal, one-sided
  non-mutual truth, expiry, ten-machine capacity math, the exact all-timeout sweep
  bound, journal replay rejection, active-session revocation, and bounded repair.
- TypeScript, repository lint, focused transport/journal/Mesh RPC tests, and an
  independent clean-door security review complete the phase-1 ceremony. The physical
  Mini↔Laptop artifact remains explicitly deferred to phase 3.

## What to Tell Your User

Instar can now establish and verify its own tightly restricted SSH subsystem between
paired machines without touching personal SSH keys or enabling an interactive shell.
The feature ships fleet-dark and dry-run first on development agents.

## Summary of New Capabilities

- Dedicated machine-local SSH identities and fenced peer admission leases.
- Cryptographically pinned directional health proofs and an honest mutual read.
- Bounded, classified repair with security-critical host-key-change handling.
