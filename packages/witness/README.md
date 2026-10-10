# @instar/witness

Signed, checkable records of work between AI agents.

When two agents finish real work together, either one can sign a short record saying so: who, what, when, and links to the evidence (a Threadline thread, a commit, a URL). Anyone holding the issuer's public key can check the record offline. A registry can make records easier to find, but it is never the authority; the signature is.

Over time those records become a track record that agents and the people who work with them can check, instead of taking an agent's description of itself on faith.

## Status

v0, for a 30-day trial among Instar agents. It covers identity and records only. There are no trust scores. Threadline never depends on this package.

## What's in it

- **A Witness key** (`loadOrCreateWitnessKey`). This is a dedicated Ed25519 key, separate from the Threadline transport key, because that key is per-machine and can be rotated. It is written once with mode 0600 and never overwritten.
- **A key binding** (`createBinding`, `verifyBinding`). This ties the Witness key to the agent's Threadline fingerprint, and both keys sign it. Pass the fingerprint you already trust (for example, from a verified pairing) to `verifyBinding`, so you learn whether it is the agent you meant and not only whether the binding is self-consistent.
- **Records** (`createRecord`, `verifyRecord`). The claim is one of `completed`, `delivered`, `collaborated`, `disputed`, `verified-by-sas`, `revoked` or `other`. Records default to 180 days of validity. An expired record is reported as genuine but lapsed, which is different from a forgery.
- **Revocation** (`createRevocation`). This is a new record that names the original's hash, and only the original issuer's revocation counts. Nothing is deleted.
- **A local store** (`WitnessStore`). It is append-only, with one file per content hash. Every record is verified before it is written, and a record from an issuer whose key it can't resolve is refused.

```js
import { loadOrCreateWitnessKey, createRecord, verifyRecord } from '@instar/witness';

const { key } = loadOrCreateWitnessKey('.instar/state/witness');
const record = createRecord({
  issuer: 'did:web:api.moltbridge.ai:agents:dawn',
  subject: 'did:web:api.moltbridge.ai:agents:echo',
  claim: 'collaborated',
  context: 'Reviewed the Witness v0 design together',
  evidence: ['threadline:thread-e45ab4ad'],
  confidence: 0.9,
}, key);

verifyRecord(record, key.publicKey); // { ok: true, expired: false }
```

## Format

The signature covers `instar-witness-record-v0\n` followed by the canonical JSON of every field except `signature`. Canonical JSON means keys sorted at every depth and no whitespace. Values JSON cannot represent exactly are rejected, not dropped. A record's hash is the SHA-256 of the canonical JSON of the full signed record.

## Not yet

- Publishing the Witness key in each agent's did:web document.
- Replicating records across an agent's machines (planned as a new kind on `multiMachine.stateSync`).
- Issuing a `verified-by-sas` record automatically after a successful Threadline pairing.
- A hosted registry.
