# Witness learns SealKeeper's SEAL reference (provisional)

## What Changed

The standalone `instar-witness` CLI can now point at a SealKeeper SEAL the way SealKeeper writes it: `witness seal-evidence seal.json --party <id> --url <read-url>` emits the single reference string `sealkeeper:seal:1:<party>:<sha256>:<url>` (parsed on the first five colons only, so the URL keeps its own colons; at most 200 characters; a party containing a colon is refused). Only the sha256 is trusted; `verify` lists the party and URL as unverified labels and says so. Because SealKeeper does not serve past SEALs by hash, the SEAL bytes now travel with the record: `seal-evidence` keeps a copy under its hash, `export` carries the bytes beside the records, and `export` and `verify --seal <file>` both check bytes against the hash and refuse a mismatch. The 0.1.0 form `seal:sha256:<hex>` plus URL is still accepted everywhere. The new form is marked `provisional` in every output until SealKeeper confirms the reading. Only `packages/witness` changes (published as `instar-witness` 0.2.0); no Instar server code.

## What to Tell Your User

Nothing changes for Instar agents. If you use the separate witness command to record work that a SealKeeper SEAL backs, it can now write SealKeeper's own reference format and carry the SEAL with the record, and checking a record will tell you whether the SEAL bytes match. The format is provisional until SealKeeper confirms it.

## Summary of New Capabilities

- `witness seal-evidence --party <id> --url <url>` emits SealKeeper's `sealkeeper:seal:1:` reference (provisional).
- `witness export` carries SEAL bytes beside records; `witness verify --seal <file>` checks them by hash. Both refuse a mismatch.
- The old `seal:sha256:` form stays accepted.

## Evidence

- `cd packages/witness && npm test`: 48 tests pass (12 new). With the source change stashed, 6 fail, so the new tests exercise the change.
