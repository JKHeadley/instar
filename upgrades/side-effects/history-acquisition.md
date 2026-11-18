# Personal history acquisition

The approved history-import spec and its acquisition addendum describe the two distinct owner decisions. The owner selects which personal account to request, then decides whether to copy the exact archive that arrived.

## Entry points and authority

A paired native owner device can discover providers through GET /mobile/imported-history/capabilities. The production default returns version 1 and an empty provider list. A machine-specific acquisition connection can supply a provider only after its personal account, dedicated browser and delivery integration are available. The current release supplies no production connection. An unavailable provider leaves the existing-file action available.

Mutations use signed messages in the local owner's private app conversation. Before work and publication, the controller checks the machine, conversation authority, current device and sharing state. Worker notices carry fixed text and stable IDs. A bearer, browser device, team member or shared chat cannot start a request. Repeating a tap or receiving a persisted chat message again must not produce a second submission.

## External and local effects

A supported driver can visit the provider's official personal settings, inspect account and workspace, then submit one official export request. The job records that it is about to submit before clicking. A crash at that point leaves the result uncertain. Recovery observes provider or delivery evidence. Cancellation stops local work. An export already accepted by the provider can still arrive.

Delivery requires a pre-existing, operation-specific permission. The optional Gmail reader checks the granted identity and corroborates sender, recipient, delivery time and message selection. The approved download transport checks links and redirects, counts bytes and stages a single archive privately. Its raw URL, mail body, credentials and page text stay out of jobs, notices and diagnostics. Jobs retain the selected email and replay metadata on the requesting machine. Snapshots and downloads use private directories and bounded streams. Recovery removes abandoned copies and archives belonging to resolved jobs. All four import directories are excluded by path from generic file serving, backup, Git tracking and peer sync. New installations and the existing Git-ignore migration both receive these exclusions. The private owner import routes continue to serve approved history.

Backups resolve configured source paths before copying. On a filesystem with private imports, a multiply-linked owner-private file is withheld because an inode with several names has no unique source path. Generic file reads and downloads also compare multiply-linked inputs with the fixed job databases, their SQLite sidecars and the imported-history manifest. A local process with filesystem access can create an external hard link to a dynamically named archive, chat or attachment. The generic viewer cannot identify that alias from its pathname. Existing Git history, files already tracked and backups made before these exclusions remain the operator's responsibility. Installing this change preserves those records.

Both import paths check the archive schema and provider, detect a changed input, and serialize writes across processes. Automatic acquisition also compares the selected account with any available export identity metadata and requires authenticated delivery even when the export omits its account identity. Existing-file import previews the file that the owner selected. An interrupted apply can leave some approved records locally. Retrying requires a fresh preview and confirmation. The importer deduplicates previously imported source records.

## Compatibility and rollback

Apps can check the signed capability at runtime. Older apps retain their existing routes. Existing-file previews remain valid for their recorded lifetime while the server process lives. A changed archive requires a new preview. A competing writer can yield a retryable busy response. The file-selection path uses a private temporary copy, requiring additional free disk space for the duration of each pass.

Removing the machine's connection omits its providers and prevents new automatic requests. If job state already exists, the current server continues local expiry and file cleanup with the connection disabled. During rollback, private job rows and staged files belong to the requesting machine. Preserve owner-approved imported history. A version without the worker cannot sweep suspended jobs, so run the worker's normal cancellation or expiry cleanup before retiring an enabled connection. No live machine was enrolled to develop this change.

## Verification and release conditions

Focused fixtures exercise device authority, private conversation checks, provider identity, request replay, restricted delivery and cancellation, snapshot integrity, competing writers and recovery. ImportedHistoryStore tests exercise two Node processes against the same state. The signed-chat lifecycle test starts a temporary AgentServer. Throughput owns the full suites and installation.

The desktop team owns the app integration and private authenticated download handoff. Each provider needs a supported transfer and a live end-to-end check on a dedicated, authorized personal test account before it is advertised. A fixture pass or a provider help page is insufficient evidence for enabling it.

The Mac app’s WKDownload callback produced a synthetic ChatGPT ZIP on the same machine. Both private snapshots matched the callback digest and byte count. The actual importer previewed one chat and one message, left the destination empty, then copied that message after confirmation. Signed app HTTP integration passed two cases, worker integration passed three and production-style temporary startup passed three. This proof used a loopback fixture and no provider account.

Automatic delivery observations stop at the original eight-day deadline. Each notice reserves an attempt before publication and permits at most five attempts across restarts. A failing chat leaves other chats eligible for delivery. After exhaustion, the owner can still read the job status. The shared controller convergence test and targeted persisted-state tests exercise both limits.

## Class-Closure Declaration

The defect class is `unbounded-self-action`. The guard is the production-backed ratchet in `tests/unit/self-action-convergence.test.ts`. The history-acquisition-notice-retry controller stops after five reserved attempts per stable notice. The history-acquisition-delivery-poll controller stops at its original eight-day deadline. Both limits survive restarting the worker. The tests also verify that one failing conversation leaves others eligible.

A native-receipt fixture exposed a cancellation race in the shared archive sink. The aborting writer can still be opening a temporary file when cancellation starts. That writer now closes and removes the file and finishes directory cleanup. The cleanup tolerates another writer winning the directory race and preserves unrecognized files.

## Merge with main after #3367 and the SEC-110 fix #3430 landed (2026-11-18 13:5x PST)

The merged tree equals main plus this PR's own changes (328174fe6..052eb0229) replayed. Two hand resolutions against #3430: `GitStateManager.init` keeps this PR's `addPrivateIgnoreRules` (a superset: all four private import folders, including `imported-history/`, and the shared/hard-linked .gitignore case) while main's default `imported-history/` line stays in DEFAULT_GITIGNORE (a harmless duplicate); `ImportedHistoryStore` uses #3430's `IMPORTED_HISTORY_DIRNAME` with this PR's per-folder private-directory check. No behaviour lost from either side. Typecheck clean; history-acquisition (3 files) + imported-history-never-syncs + GitStateManager unit files 75/75.
