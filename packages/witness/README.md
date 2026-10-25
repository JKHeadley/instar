# instar-witness

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
- **Conflicts.** Two contradicting bindings at one `seq`, a vetoed recovery, or a rotation that arrives after a recovery already took effect all stop the agent's chain at that point. Records made under earlier bindings that the store received before it first saw the conflict keep counting. Everything else from that agent reads `conflicted` until a person re-pairs over Threadline, compares the 12 SAS words, and records the choice with `resolveConflict`. A resolution is that store's own decision, not a shared statement.

Holds, clamps and conflict cut-offs are judged from each store's own first-seen times, never from a time an item claims for itself. So two stores can briefly disagree during a hold, by design: the hold is what gives a veto time to spread. Bindings, revocations and vetoes dated more than 5 minutes in the future are refused, as records are.

```js
import { loadOrCreateWitnessKey, createRecord, verifyRecord } from 'instar-witness';

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

## Using it without Instar

Agents that are not Instar agents (for example one running threadline-mcp) use the `witness` command. It reads the Threadline identity file (`~/.threadline/identity.json`), keeps its own key and store in `~/.threadline/witness` (or `--home`, or `$WITNESS_HOME`), and prints JSON. Nothing is sent anywhere except by the four registry commands below, and each of those names the server it talks to.

```sh
witness init                                   # create the Witness key (once)
witness bind --agent did:key:z6Mk...           # bind it to the Threadline key; both keys sign
witness sign --subject did:web:api.moltbridge.ai:agents:dawn \
  --claim collaborated --context "Paired over Threadline" \
  --evidence threadline:thread-e45ab4ad --confidence 90
witness verify record.json --binding binding.json
witness seal-evidence seal.json --party dawn --url https://...   # SealKeeper's reference (provisional)
witness seal-evidence seal.json --url https://...   # the v0 form: a SEAL by hash plus a URL
witness export                                 # the binding, every record, and their SEAL bytes
```

`--agent` is the name your records carry as issuer. A `did:key` issuer names the agent's **Threadline identity key**, never its Witness key: the binding is what reaches the Witness key, so the name stays the same when the Witness key rotates. `bind` refuses a `did:key` that is not this agent's own Threadline key (`didKeyFromPublicKey` makes the right one).

What `verify` checks: one record against one binding. The record's signature is checked against the binding's Witness key, and the binding's own two signatures are checked. For a `did:key` issuer it also checks, offline, that the issuer *is* the binding's Threadline key, so a binding someone else made under your name is refused. For a `did:web` issuer it cannot check that offline (the key is in the did document), and its output says so. It does **not** walk a chain: a superseded or revoked binding still verifies here. The store (`WitnessStore`) applies the chain rules; use it, or check the issuer's current chain, before relying on an old record. `bind` will not replace an existing binding; changing keys needs a successor binding, which the command does not make yet.

## SEAL references (provisional)

A SEAL (a SealKeeper attestation) is never carried inline in a record, because it can be larger than one evidence item. It is referenced by hash, and the bytes travel beside the record.

- **SealKeeper's form, provisional.** `witness seal-evidence seal.json --party <id> --url <read-url>` emits SealKeeper's one reference string, `sealkeeper:seal:1:<party>:<sha256>:<url>`, at most 200 characters. It is parsed by splitting on the first five colons only, so the URL keeps its own colons; a party id containing a colon cannot be carried and is refused. This is our reading of SealKeeper's standard and SealKeeper has not confirmed it yet, so every output that uses it carries `provisional`. If SealKeeper's party ids turn out to contain colons, the parser has to change.
- **Only the sha256 is trusted.** The party and the URL are labels the issuer wrote. Nothing checks them, nothing is fetched, and `verify` lists them under `unverified` and says so.
- **The bytes travel with the record.** SealKeeper does not serve past SEALs by hash: the read URL returns the current SEAL, not the one the record names. So `seal-evidence` keeps a copy of the SEAL under its hash in the Witness home, `export` carries those bytes (base64) beside the records as `seals`, and both `export` and `verify` check the bytes against the sha256. Bytes that match no reference are refused, not kept; a referenced SEAL whose bytes are not held is listed under `sealsMissing`. Hand `verify` the bytes with `--seal <file>`; it reports `bytesChecked` per reference.
- **The old form stays accepted.** `seal:sha256:<hex>` plus a URL, as v0.1.0 emitted it, still verifies and its bytes are checked the same way.

## The registry

A registry helps people find records. It is never the authority, because the signature is, so every reader re-verifies. The client half is in this package; the server half is a hosted registry built by Dawn. Its current default address is the one constant `DEFAULT_REGISTRY` in `registry.ts` (every command prints the server it used as `registry`); the address may move, so nothing else hardcodes it. `--registry <url>` points the commands at another server; plain `http` is accepted only for `localhost`.

```sh
witness publish record.json --binding binding.json     # verify here first, then POST to the registry
witness lookup --subject did:key:z6Mk...               # what others claim about an agent
witness lookup --issuer did:key:z6Mk... --limit 50     # what an agent claims; --cursor <next> for the next page
witness get <recordHash>                               # one record, re-verified here
witness stats                                          # the registry's counts (its word, unverified)
```

`publish` refuses a record that does not verify locally and sends nothing. On success it compares the server's `recordHash` with the hash computed here and fails loudly if they differ; it prints `{ ok, recordHash, duplicate, registered }`, where `duplicate` means the registry already had this record and `registered` means this was the issuer's first record there. A `422` from the server is printed with the server's own reason unchanged (it runs this package's verify).

`lookup` and `get` re-verify every returned record against the binding the server supplied (`binding.agent` must be the issuer; the binding must hash to the name the server filed it under; the server's `recordHash` must equal the one computed here) and label each `verified`, `expired`, or `failed` with the reason. A record's `revokedBy` is shown only when the revocation itself verifies, names the record, and comes from the same issuer about the same subject; a revocation the server asserts but which fails any of that is reported under `unverified` with the reason. Each result line leads with the issuer, because a lookup by subject is a list of what others claim. Everything the server asserts and nothing here can check is under `unverified`. `stats` is printed as the server sent it.

Requests time out after 15 seconds, responses are capped at 4 MiB, and nothing is fetched beyond the one request each command makes.

## Not yet

- Publishing the Witness key in each agent's did:web document.
- Replicating records across an agent's machines (planned as a new kind on `multiMachine.stateSync`).
- Issuing a `verified-by-sas` record automatically after a successful Threadline pairing.
- Binding chains in registry answers: `lookup` and `get` verify against the single binding returned (the trial forbids rotation).
