# Witness: SealKeeper's SEAL reference — Plain-English Overview

> The one-line version: the `witness` tool learns to point at a SealKeeper SEAL the way SealKeeper writes it, to carry the SEAL's bytes along with the record, and to check those bytes by hash; it is marked provisional until Carl confirms the format.

## The problem in one breath

A Witness record is a signed note that one agent makes about work with another, with links to evidence. One kind of evidence is a SEAL, an attestation issued by Carl's SealKeeper service. Today `witness` points at a SEAL with its own two-item shorthand (a hash plus a URL) on the assumption that the URL fetches the SEAL. Two facts from Carl break that: SealKeeper defines one reference string of its own (`sealkeeper:seal:1:<party>:<sha256>:<url>`), and SealKeeper does not serve old SEALs by hash, so the URL returns whatever SEAL is current, not the one the record named. A verifier following the URL could be checking the wrong SEAL without knowing it.

## What already exists

- **The `witness` command** — makes a key, binds it to the agent's Threadline identity, signs records, verifies records offline, and exports the binding plus records. It is published on npm as `instar-witness` 0.1.0.
- **`witness seal-evidence`** — hashes a SEAL file and prints two evidence items: `seal:sha256:<hex>` and an optional URL. The SEAL itself is never inside the record, because a record's evidence items are capped at 500 characters.
- **Evidence items** — plain strings in the record; the signature covers them, so a verifier knows the issuer wrote them, but nothing checks what they point at.

## What this adds

`witness seal-evidence seal.json --party <id> --url <read-url>` now prints SealKeeper's one reference string instead of the two-item shorthand, and keeps a copy of the SEAL under its hash in the Witness home. `witness export` carries those bytes beside the records, and `witness verify` accepts the bytes (`--seal <file>`) and checks them against the hash in the reference. The two-item shorthand from 0.1.0 still works everywhere.

- The reference is read by splitting on the first five colons only. Everything after the fifth colon is the URL, since URLs contain colons themselves. A party id that contains a colon cannot be carried and is refused when writing a reference.
- Only the hash is trusted. The party and the URL are labels the issuer typed; `verify` lists them under `unverified` and says so in words. Nothing is fetched.
- Bytes that match no reference in the record are refused by both `export` and `verify`. A referenced SEAL whose bytes are not on hand is listed under `sealsMissing` rather than invented.
- Every output that uses the new form carries a `provisional` note, because the format is our reading of Carl's standard and he has not confirmed it yet.

## The new pieces

- **`seal.ts`** — the parser, the writer, and the byte check for SEAL references. It is pure: no network, no file access, no decisions about whether a record counts. It is allowed to say "this is a SealKeeper reference, here is its hash, here are its labels, these bytes match or do not." It is not allowed to fetch anything or to treat a party or URL as verified.
- **`seals/` in the Witness home** — a copy of each SEAL named by its sha256, written once, so an export months later still has the bytes. A stored file whose content no longer hashes to its name is refused, never carried.

## The safeguards

**Prevents a wrong SEAL from passing as the right one.** The only link between a record and SEAL bytes is the sha256. Bytes are checked by hash on both the writing side (`export`) and the reading side (`verify`); a mismatch is a refusal in both.

**Prevents a typed label from reading as a verified fact.** The party and URL in a SealKeeper reference are never checked and never presented as checked. The verify output names them `unverified`, next to the one field that was checked.

**Prevents a format guess from hardening into a standard.** Outputs using the new form say `provisional`. The README says the same and names the one open question (party ids with colons). Nothing else in the package depends on the new form, so changing the parser later touches one file.

**Prevents breaking existing records.** The 0.1.0 form is still accepted on every path, and its bytes are checked the same way.

## What ships when

One pull request, held with the `hold` label until Justin confirms. It changes only the `instar-witness` package (its CLI, a new module, tests, README). No Instar server code, no hooks, no config. Merging it publishes a new `instar-witness` to npm through the existing workflow.

## What you actually need to decide

Is it fine to ship SealKeeper's reference form as provisional now, before Carl confirms the reading, with the old form still accepted and the parser isolated so it can change if his party ids contain colons? Yes or no.
