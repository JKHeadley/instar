# @instar/witness

Signed, checkable records of work between AI agents.

When two agents finish real work together, either one can sign a short record saying so: who, what, when, and links to the evidence (a Threadline thread, a commit, a URL). Anyone holding the issuer's public key can check the record offline. A registry can make records easier to find, but it is never the authority; the signature is.

Over time those records become a track record that agents and the people who work with them can check, instead of taking an agent's description of itself on faith.

## Status

v0, for a 30-day trial among Instar agents. It covers identity and records only. There are no trust scores. Threadline never depends on this package.

## What's in it

- **A Witness key** (`loadOrCreateWitnessKey`). A dedicated Ed25519 key, separate from the Threadline transport key, because that key is per-machine and can be rotated. It is written once with mode 0600 and never overwritten.
- **Key bindings** (`createBinding`, `createSuccessorBinding`, `createBindingRevocation`, `createSuccessorVeto`). A binding ties a Witness key to the agent's Threadline fingerprint and is signed by both keys. Bindings form a chain per agent, and each successor names the hash of the binding it replaces and is also signed by that binding's keys. The rules for changing keys are below.
- **Records** (`createRecord`, `verifyRecord`). The claim is one of `completed`, `delivered`, `collaborated`, `disputed`, `revoked`, `other`, or `verified-by-sas` (reserved for the Threadline pairing hook; nothing issues it automatically yet). `confidence` is an integer from 0 to 100. Records default to 180 days of validity, and an expired record is reported as genuine but lapsed, which is different from a forgery.
- **Revocation** (`createRevocation`). A new record that names the original's hash. Only a revocation from the original's issuer about the same subject counts. Revocations have no `valid_until` and never lapse, and a revocation cannot itself be revoked. Nothing is deleted.
- **A local store** (`WitnessStore`). Append-only, one file per content hash, every item verified before it is written, and every file re-checked against its name when read.

## The rule that ties a record to its issuer

A record counts only if its `key_id` belongs to a binding in the issuer's effective chain (`binding.agent === record.issuer`) that was current at the record's `issued_at`, and that binding was not revoked as of then. `WitnessStore` enforces this. `verifyRecord` on its own checks only the signature against the key you hand it.

## Changing keys

These rules rest on one fact: stealing a key copies it, so in a theft the real owner still holds both keys.

- **Rotation.** A successor signed by both keys of the previous binding takes effect at once. Someone holding only one stolen key cannot produce it.
- **Recovery.** A successor signed by one previous key is for a key that is actually lost. A store holds it for 72 hours from when the store first saw it, and during that time it neither counts nor closes the previous window. The previous key that didn't sign it can veto it during the hold. Once it matures, its window starts no earlier than first-seen, so it cannot reach back over records already made. A two-key rotation that arrives during the hold wins.
- **Revocation.** A binding revocation signed by one key takes effect no earlier than first-seen minus 5 minutes. That makes it an instant stop for the future, and the worst a thief can do with it is shut the agent out. Backdating `effective_from` needs both keys.
- **Conflicts.** Two contradicting bindings at one `seq`, a vetoed recovery, or a rotation that arrives after a recovery already took effect all stop the agent's chain at that point. Records made under earlier bindings that the store received before it first saw the conflict keep counting. Everything else from that agent reads `conflicted` until a person re-pairs over Threadline, compares the six SAS words, and records the choice with `resolveConflict`. A resolution is that store's own decision, not a shared statement.

Holds, clamps and conflict cut-offs are judged from each store's own first-seen times, never from a time an item claims for itself. So two stores can briefly disagree during a hold, by design: the hold is what gives a veto time to spread. Bindings, revocations and vetoes dated more than 5 minutes in the future are refused, as records are.

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
