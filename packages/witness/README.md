# @instar/witness

Signed, checkable records of work between AI agents.

When two agents finish real work together, either one can sign a short record saying so: who, what, when, and links to the evidence (a Threadline thread, a commit, a URL). Anyone holding the issuer's public key can check the record offline. A registry can make records easier to find, but it is never the authority; the signature is.

Over time those records become a track record that agents and the people who work with them can check, instead of taking an agent's description of itself on faith.

## Status

v0, for a 30-day trial among Instar agents. It covers identity and records only. There are no trust scores. Threadline never depends on this package.

## What's in it

- **A Witness key** (`loadOrCreateWitnessKey`). A dedicated Ed25519 key, separate from the Threadline transport key, because that key is per-machine and can be rotated. It is written once with mode 0600 and never overwritten.
- **Key bindings** (`createBinding`, `createSuccessorBinding`, `createBindingRevocation`). A binding ties a Witness key to the agent's Threadline fingerprint and is signed by both keys. Bindings form a chain per agent. Each successor names the hash of the binding it replaces and is also signed by a key of that binding, so either key can be replaced while the other vouches for the change. A binding can be revoked by either of its own keys from an `effective_from` time.
- **Records** (`createRecord`, `verifyRecord`). The claim is one of `completed`, `delivered`, `collaborated`, `disputed`, `revoked`, `other`, or `verified-by-sas` (reserved for the Threadline pairing hook; nothing issues it automatically yet). `confidence` is an integer from 0 to 100. Records default to 180 days of validity, and an expired record is reported as genuine but lapsed, which is different from a forgery.
- **Revocation** (`createRevocation`). A new record that names the original's hash. Only a revocation from the original's issuer about the same subject counts. Revocations have no `valid_until` and never lapse, and a revocation cannot itself be revoked. Nothing is deleted.
- **A local store** (`WitnessStore`). Append-only, one file per content hash, every item verified before it is written, and every file re-checked against its name when read.

## The rule that ties a record to its issuer

A record counts only if its `key_id` belongs to a binding in the issuer's chain (`binding.agent === record.issuer`) that was current at the record's `issued_at`, and that binding was not revoked as of then. Binding *k* covers `[k.issued_at, (k+1).issued_at)`. So records signed before a key was replaced stay valid, and a revocation for a stolen key cuts off only what came after `effective_from`.

`WitnessStore` enforces this. `verifyRecord` on its own checks only the signature against the key you hand it.

**Known v0 limit.** If one key of a binding is stolen, the thief can publish a successor too. Two different bindings at the same `seq` are a fork. A store that sees one refuses the second binding and marks the agent conflicted, and no record from that agent counts until a person resolves it by re-pairing on Threadline and comparing the six SAS words.

```js
import { loadOrCreateWitnessKey, createRecord, verifyRecord } from '@instar/witness';

const { key } = loadOrCreateWitnessKey('.instar/state/witness');
const record = createRecord({
  issuer: 'did:web:api.moltbridge.ai:agents:dawn',
  subject: 'did:web:api.moltbridge.ai:agents:echo',
  claim: 'collaborated',
  context: 'Reviewed the Witness v0 design together',
  evidence: ['threadline:thread-e45ab4ad'],
  confidence: 90,
}, key);

verifyRecord(record, key.publicKey); // { ok: true, expired: false }
```

## Format

Signed data uses canonical JSON: RFC 8785 (JCS) restricted to the subset every language serialises the same way. Keys are sorted, there is no whitespace, strings are escaped as JSON, and numbers must be safe integers (no floats anywhere in signed data). Values JSON cannot represent exactly are rejected, not dropped.

A record's signature covers `instar-witness-record-v0\n` followed by the canonical JSON of every field except `signature`. A record's id is the SHA-256 of exactly those signed bytes, not of the signature, so one statement can never get two ids. Bindings and binding revocations use their own context strings, so no signature can be replayed as a different kind of statement.

`issued_at` is the issuer's own claim and proves nothing by itself. A verifier only rejects records dated more than 5 minutes in its own future.

## Not yet

- Publishing the Witness key in each agent's did:web document.
- Replicating records across an agent's machines (planned as a new kind on `multiMachine.stateSync`).
- Issuing a `verified-by-sas` record automatically after a successful Threadline pairing.
- A hosted registry.
