# Native keyword search for imported history

Tier 2 on the approved import-from-claude-chatgpt spec §B.3–4. The base spec converged in four rounds. This change adds a source to the established search and an optional local date order. It introduces no mesh command, indexing job or shared history record.

## Decision and authority

The native owner's signature and person binding authorize reading imported messages. The existing signed mobile-device authenticator sets these fields. A directly connected native owner sees local imported hits with a source label, original reference, original message key, highlighted snippet and the holding machine. An agent bearer retains the separate quoted-history API. Browser, team, MSP, notification and pool credentials cannot activate the native import source. This uses an authenticated role under the signal-vs-authority principle. Text and user-supplied hints never grant access.

## Over-block and under-block

Scoped searches for imported refs stop at the selected machine. Legitimate owners pick the paired machine that holds the import. The app can request only a presence flag and available machine ID through a signed location read. A single-machine deployment may lack a registered mesh ID, in which case the app knows its connected target. Keyword scans return their bounded window and mark incomplete results as capped. Files, messages and elapsed time bound the streamed import scan. Invalid rows and missing files mark the result incomplete. Source dates fall back to the conversation creation time, and an unknown date sorts last.

## Ordering and interaction

Ordinary search keeps its relevance order and existing limit. The native owner can request local keyword results with order=date to merge imported and ordinary results by date. A stable result identity breaks time ties. An opaque cursor carries a date and digest. The app echoes it with the same query and order. Neither local date pages nor scoped imported ids are sent to peers. On an ordinary pool query the peer receives the normal query alone, and its credential cannot read private imports. The peer-hit parser still rejects imported refs. Page order applies within existing scan and SQL limits, with capped set if a source hits its bound.

## Meaning and machine behavior

Imported chats stay outside ConversationEmbeddingIndex and its progress totals. The existing production default is a local ONNX model. The generic injected Embedder has no declaration that an implementation keeps input on-device. Adding an imported source to that feeder without a local-only guarantee and owner-scoped result visibility would be inconsistent with the spec. No remote embedding service is added. No synchronization, location broadcast, document creation, transcript preload or system-prompt write is involved.

## Rollback

Revert the search handlers, date-order query and store reader. Historical files and schemas require no migration. A previous app keeps its existing search query. Reading location on this release requires the existing signed native-owner route; older servers may ignore the query parameter, so an app must validate the exact location response shape before using it.

## Verification

Targeted tests check direct native reads, date pages crossing ordinary and imported messages, legacy ranking, peer-hit rejection, scoped fan-out refusal, and exclusion of bearer, team and browser calls. The route integration uses real device signatures. The E2E test uses production AgentServer construction with a real stored import and verifies the existing meaning feeder's calls.

## Independent review and corrections

The project reviewer identified that a first SQL implementation ordered Telegram rows tied on date differently from the cross-source cursor. The server now assigns each dated Telegram result its intrinsic SQLite row ID, and SQL applies the same date and row-ID comparison before LIMIT. A regression reads 511 rows tied on time and one older row through successive pages without loss or duplication. The reviewer also identified a risk from different active operator profiles sharing the owner role. Search and location now revalidate the actual signing device, key ledger and owner profile with the same policy used for private history acquisition. Multiple active devices of one owner can use the source. A different current owner profile or a grant sharing owner conversations suppresses the source. The handler rechecks after asynchronous decoding and after any peer fan-out, before sending the response. Legacy imports have no per-person historical owner field. Current admission establishes eligibility on the machine but cannot recover the historic importer's identity.

The independent second pass concurred after verifying that the SQL cursor applies the same row ID before LIMIT and the signed owner's authority is rechecked after local reads and peer requests.

## Merge with main after #3367 landed (2026-11-18 13:5x PST)

#3367 (this PR's parent) was squash-merged, so the PR now targets main. The merged tree equals main plus this PR's own changes (328174fe6..e8626ec25) replayed; release notes for #3367 were already consumed by a release, so only this PR's fragment stays in upgrades/next. No behaviour change. Typecheck clean; imported-conversation-search + imported-history unit files 15/15.
