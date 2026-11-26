# Witness: registry client commands — Plain-English Overview

> The one-line version: the `witness` tool gains four commands that talk to a registry server (run by Dawn) so an agent can publish a signed record and anyone can look records up; every record read back is re-checked on your own machine, because the registry is a place to find records, never the thing that makes them true.

## The problem in one breath

A Witness record is a signed note one agent makes about work with another. Until now every record travelled hand to hand: the `witness` tool could sign and check records but never sent one anywhere, and there was no place to find the records other agents had made. The 30-day trial needs an outside agent to register and a lookup to change a real decision, which is impossible with no shared place to look. Dawn and Echo agreed a split on 2026-10-25: Dawn builds the server routes, Echo builds the commands in `instar-witness` that talk to them. This change is Echo's half.

## What already exists

- **The `witness` command** — makes a key, binds it to the agent's Threadline identity, signs records, verifies a record against a binding offline, and exports everything. Published on npm as `instar-witness` 0.1.0, and until now it sent nothing anywhere.
- **`witness verify`** — the one check that decides whether a record counts: the binding's own two signatures, the issuer being the agent the binding names, a `did:key` issuer really being the binding's Threadline key, and the record's signature.
- **The registry routes** — Dawn's server, live since 2026-10-25 at the current default address (kept in one constant, since the home may move): publish a record, list records by subject or issuer, fetch one by hash, and a stats page that shows which agents have registered.

## What this adds

Four commands. Each one is explicit, named, and the only way the tool ever opens a network connection.

- **`witness publish record.json --binding binding.json`** runs the local check first and sends nothing if it fails. Then it posts the record with its binding. The server answers with the id it computed for the record; the command compares that with the id computed here and fails loudly if they differ. It prints whether the record was new or already there, and whether this was the issuer's first record (that is what "registered" means for the trial). If the server refuses, the server's own reason is printed unchanged.
- **`witness lookup --subject <did>`** (or `--issuer`) lists records and re-verifies every one of them here, against the binding the server supplied. Each is labelled `verified`, `expired` (genuine but lapsed) or `failed` with the reason. Each line starts with the issuer, because a lookup by subject is a list of what others claim. Pages pass a cursor through for the next page.
- **`witness get <hash>`** fetches one record and re-verifies it the same way, and refuses a record that is not the one asked for.
- **`witness stats`** prints the registry's own counts as the server sent them, labelled as its word.

Revocations are handled carefully: a record is shown as revoked only when the revocation itself verifies, names that record, and comes from the same issuer about the same subject. A revocation the server merely asserts is reported under `unverified` with the reason it was not honoured.

## The new pieces

- **`localverify.ts`** — the check `witness verify` always ran, pulled into one function so publishing and reading back use the identical sequence instead of a copy. It is allowed to say whether one record verifies against one binding; it is not allowed to consult a server.
- **`registry.ts`** — the only networking code in the package. It vets the server URL (https, or plain http only for localhost), times requests out after 15 seconds, caps responses at 4 MiB, and turns a server's page into labelled, re-verified rows. It uses Node's built-in fetch; no new dependency.

## The safeguards

**Prevents the server from becoming the authority.** Nothing a server says is trusted. The server's record id must match the one computed here; the binding it supplies must hash to the name it filed it under and must name the issuer; the record's signature is checked here. Anything else the server asserts is printed under `unverified`.

**Prevents sending a record this machine would not vouch for.** `publish` verifies first and refuses before any connection is opened.

**Prevents a mislabelled publish from passing as success.** If the server's id differs from the local one, the command fails with both ids and says it is not treating the record as published.

**Prevents a silent or runaway network call.** Only four named commands reach the network; every request has a timeout and a size cap; a non-https server is refused unless it is localhost (a test server).

**Prevents a fake revocation from hiding a genuine record.** A revocation counts only when it verifies and comes from the record's own issuer.

## What was tested

Seventeen unit tests run the commands against a local fake server: local refusal before sending, a server id that does not match, the server's 422 reason passed through unchanged, a duplicate, a tampered record labelled failed, an expired record labelled expired, a revocation that fails verify not honoured (and one from another issuer, and one the server only asserts), the cursor passed through, `get` refusing the wrong record, the URL rule, the size cap, and the timeout. All 55 tests in the package pass.

Then the live server: Dawn's record re-verified from `lookup` and `get`; Echo's real record about Dawn published (`registered: true`), re-published (`duplicate: true`), fetched back by hash and verified; a tampered copy sent straight to the server answered 422 `bad signature`, and the client itself refused the same tampered record before sending; `stats` shows two issuers and two records; a `get` for an unknown hash reports "no record".

## What ships when

One pull request to `packages/witness` (published as `instar-witness` 0.2.0). No Instar server code, no hooks, no config. It overlaps with the open SealKeeper PR (#2350) on the CLI header, the option list, the `verify` case, the README and the version; whichever lands second rebases and takes the next version number.

## What you actually need to decide

Nothing beyond the merge: the server is live and the commands were tested against it. The only judgment call made here is that a revocation the server asserts but which does not verify is reported, never honoured.
