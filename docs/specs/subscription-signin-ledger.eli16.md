# Subscription Sign-In Ledger — plain English

Justin has eight subscription accounts across four machines, and repairing one apparent sign-out
costs roughly fifteen taps. Until now the system kept only a snapshot of which accounts looked
healthy. It could not answer how often sign-ins failed, how long repair took, which machine or
account was worst, or whether a credential genuinely died versus the checker merely failing to
read it. That distinction matters: automatically signing in again can hide the bug that removed a
perfectly good login.

This design adds a local, private, bounded evidence store on each machine. It records confirmed
status incidents only when the existing quota/refresh path has enough evidence to mark an account
`needs-reauth`, then records recovery when that status clears. Those incidents carry a closed cause
class. Separately, repeated failures to read a credential create provisional “credential-read
observation windows.” They are not incidents, never trigger repair, never remove account capacity,
and never enter incident counts or time-to-fix statistics. This separation exists because a Mac
keychain timeout can look identical to a deleted credential; the ledger must expose that ambiguity
without turning it into another false sign-in prompt.

The ledger also records coverage: whether each admitted account/machine cell actually passed
through the authentication observation path. A zero therefore cannot mean both “nothing failed”
and “nothing was watching.” Statistics stay null until they meet explicit evidence floors, and
retention truncation remains visible. Incident history and provisional credential-read history
have independent retention floors, so churn in one cannot erase confidence in the other.

Everything is bounded: at most 64 observed cells, at most 4,096 pool rows examined per pass,
fixed page sizes, hard SQLite row caps, 180-day retention, bounded peer fan-out, and bounded failure
sidecars. No email, sign-in code, token, secret URL, or free-text error is stored. A single lock
owner controls both the database and its independent refusal sidecar; real competing-process tests
prove a second instance cannot write either carrier.

The ledger depends on a separate pool-authority foundation. That prerequisite makes pool reads
bounded and ensures corrupt or unreadable authority is never misreported as “zero accounts.” Its
deployment uses a reader-first release followed by a separately gated migration release so rolling
back to the real prior version does not strand subscription authority. Compatible code keeps old
ledger history readable while a live pool is invalid or unavailable; only observation pauses.

Each machine keeps its physical observations locally. `?scope=pool` performs a bounded read-time
merge and names unreachable or degraded peers instead of silently omitting them. This requires no
per-machine setup: it ships with Instar, creates its own private store, and rides the quota polling
cycle already running.

This is measurement, not the sign-in robot. It never signs in, sends a notice, changes account
selection, or gates work. The guarded browser identity and agent-driven sign-in automation remain
separate features. Building them after this ledger means automation can respond to measured causes
instead of repeatedly masking a checker defect.
