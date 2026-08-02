# Decision Quality Enforcement Teeth — ELI16

Instar already has a list of model-backed decision areas. The live updated runtime
now says 39 are wired, 19 are pending, and 6 are exempt, with the same total of 64
it had before the enrollment. But it is still a list written by people. It does not
prove that every actual place in the program that calls a model is represented
once.

That distinction matters. One list row can hide two different model calls. A stale
row can name a feature that no longer calls a model. A helper can hide a call from a
text search. If the list and the program disagree, a percentage calculated from the
list can look complete while real calls remain invisible.

That means 39 out of 64 is not yet a floor on real coverage. Removing aliases could
make the true share higher; discovering hidden calls or splitting one row into
several decisions could make it lower. The honest statement today is only: 39 of
64 declared catalog rows are wired, up from 11. The share of actual production
decision origins is unknown until the compiler-derived set exists.

This spec gives the list enforcement teeth.

First, one TypeScript compiler driver type-checks and inventories the same production
program, reusing one in-memory program instead of doing the expensive work twice.
It follows references to the real provider and router method declarations, so it
finds model calls even when the variable is called `brain` instead of `provider`.
It rejects extracted callbacks, `.call`/`.apply`, computed access, and unresolved
higher-order aliases instead of letting those forms disappear from the count. It
still ignores unrelated methods that merely happen to be named `evaluate`.

A second guard resolves the repository's build, package, and runtime entrypoints.
It refuses a production file omitted from the TypeScript program and refuses direct
provider or model-SDK egress outside the typed decision boundary. This matters
because a detector cannot prove completeness merely by reporting everything it was
configured to see.

Every model-call expression must then be one of two things:

- a decision origin, where a real semantic judgment begins; or
- an infrastructure forwarder, where the router, queue, breaker, or provider passes
  along a judgment that was already identified.

The second category prevents double-counting. A single decision may travel through
the router and a provider, but it is still one judgment. Calling something a
forwarder in a list is not enough. The checker tracks one linear decision-context
token and permits only a finite grammar: parameter/context reads, single-assignment
aliases, allowlisted object reconstruction/defaults, identity-preserving retry or
swap, and terminal carrier removal after settlement ownership transfers. Arbitrary
callbacks, mutation, recursion, mixed-token branches, fan-out, and aggregation are
not proof. The analysis memoizes its call graph and has explicit complexity bounds;
if a cyclic, generic, or wide-union case exceeds them, the build fails instead of
guessing. Forwarders remain visible and checked; they just do not pretend to be
extra decisions.

The real queue and retry code does use callbacks and loops, so the spec does not
pretend a blanket ban describes it. Those exact implementations are pinned and
analyzed as narrow combinators: one readonly context, one non-cloned queue thunk,
sequential bounded attempts, no result aggregation, and one settlement or transition
owner. Changing their body or callback behavior reopens the proof.

Each decision origin must use one stable imported decision ID and one generated
per-callsite capability. The compiler binds that capability to exactly one source
origin; forwarders can carry it only through the linear context. Two model calls in
one larger workflow get two IDs and capabilities plus one shared composition ID. A
generic helper is not allowed to hide several different judgments behind one vague
identity.

The first implementation does not have to pretend the nine known identity repairs
are already solved. Before the generator implementation begins, however, a separate
PR with an independent authenticated reviewer must merge the exact map from those
nine findings to a named source commit, source symbols, expected call counts, unique
repair markers, and source fingerprints. The generator pins that earlier artifact's
merge commit and digest; its own PR may consume but not rewrite it. The list can
shrink but cannot grow, swap sites, or let a newly inserted call inherit an old
ordinal, and none of its rows can be called wired.

The compiler produces a small generated manifest containing source identities and
shape only. One allowlisted data serializer rejects machine paths, parent traversal,
source text, registry prose, arbitrary errors, prompts, messages, responses,
screenshots, terminal output, and secrets. Continuous integration regenerates the
manifest and refuses any difference that was not checked in deliberately. Its
method digest also covers the complete TypeScript configuration, production source
membership, entrypoints, exclusions, and every analyzer helper, so changing what
the compiler sees forces a new converged audit.

The executable callsite set and the invocation census must match both ways:

- every real decision-origin callsite must have one census row; and
- every invocation census row must have one real callsite.

A mismatch fails the build and prints both sides of the difference. Opening a work
item may help somebody follow up, but it cannot turn the check green or allow the
change to merge. During the first migration, unresolved identity work can use only
the exact closed `repair-required` list; a missing census row cannot.

This is stronger than checking only that new calls appear in the list. It also
catches stale rows, duplicate identities, hidden multi-call rows, and entries that
claim to be wired without proving they reach the shared router.

Aliases and delegates that do not actually call a model move to a separate human
catalog. They remain documented, but they no longer inflate the denominator or its
coverage percentage. For one release, old readers receive clearly labeled legacy
and new totals side by side.

At runtime the caller cannot claim its own callsite or manifest revision. The router
uses the generated capability to look up the exact row in its embedded manifest and
writes the row's identity itself. Static analysis catches a valid capability copied
to another origin; runtime honestly limits itself to unknown, stale, or mismatched
tokens and context. Mismatched or forged context cannot claim reconciled status, but
the observability path also cannot reject or change the model result. A pending
direct-provider chain has one registered transition owner that attempts its labeled
observation before the provider strips the carrier; it is not promoted to a wired
router settlement. Every recorder write is bounded, non-throwing, and
exception-isolated; an unavailable sink may lose its secondary counter but must
preserve the original result, error, routing, and enactment byte-for-byte. Local
operator diagnostics may resolve source keys; fleet views receive opaque row IDs
and fixed reason codes, never source paths or raw errors. This lets Instar
distinguish “the source says this call exists” from “the running system actually
observed and settled it.” A call with no traffic is not falsely called working. A
failure or timeout still settles against the same identity.

The second half fixes the grading queue.

Today the hourly grader has 200 seats divided equally among five decision points.
If four points have nothing ready, 160 seats go unused while the busy point is still
limited to 40. Worse, if the budget is smaller than the number of points, the
current minimum-one rule can inspect more rows than the supposed global limit.

The new default is 500 inspected rows per pass, with a real global cap. The grader
first gives every point a fair allocation. Empty, waiting, or backed-off points hand
unused seats back. Busy points then reuse those seats in a rotating order. If there
are fewer seats than points, a durable next-point key moves between passes so the
same tail cannot starve forever, even when points are added or removed.

Work happens in bounded materialized pages whose database statement closes before
annotation writes. Reads and affected rollups are batched, avoiding both a busy
SQLite connection and repeated whole-bucket rescans. A retryable bad row backs off;
a permanent bad row can stop starving later evidence only through an audited
`unknown/quarantined` disposition, which is never counted as a grade.

The local lease carries an owner, worker, epoch, nonce, and expiry. Every page
reservation and every annotation, cursor, renewal, and release checks that fence.
If a paused worker wakes after takeover it must stop, and persisted allocation and
refill progress let the successor resume the same unfinished pass budget rather
than receiving another 500 seats. A remote machine cannot acquire the local ledger
lease. The read surface reports takeovers,
lost leases, abandoned reservations, duration, and throughput as well as allocated,
inspected, graded, reclaimed, and unused capacity.

Before a page read, the worker reserves at most 25 seats. After a live read returns
`m` rows from `r` seats, one fenced transaction charges `m` and returns `r - m` to
the pool. If the worker crashes or loses its lease first, all `r` remain charged and
cannot be handed to its successor. That deliberate waste on failure prevents two
workers from both spending the same seats while letting ordinary empty pages return
capacity to the hot point.

The budget counts every row the grader examines, not only rows that receive a new
grade. The load oracle is fixed up front: 3,000 starting rows, 300 arrivals before
each of 12 hourly passes, exact five-point distributions, 25-row pages, and numeric
query/time/memory/event-loop ceilings. At 500, no more than 600 rows and three hours of
age may remain; the 200-row comparison is reported separately. A 30-minute restarted
dev-agent window must also show matching manifest revisions and no unknown or
mismatched live identities. That makes “we visited 500 rows” impossible to present
as “we learned 500 correct outcomes.”

Nothing here gives a model new authority, sends data elsewhere, changes prompts, or
manufactures ground truth. It makes the source denominator exact and uses existing
deterministic grading capacity efficiently. The nine identity repairs and ten
blocked or stale rows remain real follow-on work, now against a denominator the
repository can prove.
