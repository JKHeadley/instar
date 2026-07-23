# Side-effects review — reliable peer-machine execution

## Authority and write boundary

The new effect grants the paired machine's dedicated Instar client key access to
the current agent account. Authority is the conjunction of the existing signed
advert checks and fresh mutual directional proofs at the registry's current
pairing epoch. Neither discovery, an advert, nor one directional probe can write.

The only write target is `<account-home>/.ssh/authorized_keys`. Symlinked target
components are refused; the directory and file are forced to 0700/0600; replacement
is atomic. Instar owns only `instar-peer-access` lines. Human keys survive byte-for-
byte as lines, and peer rotation replaces rather than accumulates managed grants.

## Revocation, retries, and partial failure

Peer removal or re-pair epoch change removes the managed line. A crash before rename
leaves the old canonical file intact. A crash after rename leaves the complete new
file. Reconciliation is idempotent. Dry-run performs no filesystem mutation.
Failure stays named in mutual-SSH health; there is no success fallback.

## Signal versus authority

The advert and probe results are signals. `MutualSshVerifier.mutual`, with live boot
ids, exact generations, pairing epoch, and monotonic freshness, is the authority.
`PeerAuthorizedKeys` performs no trust decision and accepts only the already
authorized record passed by the runtime.

## Class closure

This closes the “verified bootstrap never installs standing access” defect class
with the machine-coherence N5 ratchet, dark-gate golden map, guard manifest, and
tests for target scope, idempotency, rotation, revocation, dry-run, permissions,
and symlink refusal.
