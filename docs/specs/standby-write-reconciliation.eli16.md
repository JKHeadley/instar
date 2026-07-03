# Fix the "standby machine can't save its own work" problem (plain-English overview)

Companion to `standby-write-reconciliation.md` (round-3 revision).

## The problem

When the agent runs on two machines (the Mini and the laptop), there's a rule
meant to prevent them from stepping on each other: only ONE machine — the one
holding the "serving lease" — is allowed to save anything. The other machine
is "standby" and its whole saving system is switched off with a single on/off
switch.

That rule made sense when only one machine did work at a time. But the newer
session-pool feature deliberately runs conversations on BOTH machines at once.
So now the laptop can be actively running your conversations while its saving
system is switched off — it literally cannot write down things about the very
sessions it is running. We caught it live: the laptop logging "Failed to
record build context … this machine is on standby" about a session it owned.
Add a third machine and it gets worse: every extra machine is a worker that
can't save.

There's a second, sneakier problem. When a machine can't (or shouldn't) accept
a save, it's supposed to say so clearly and fast. Instead, two API endpoints
were observed just hanging — no answer, no error, nothing, for 90+ seconds.
We traced the hangs: they're not caused by the saving rule at all, but by the
whole process occasionally freezing up (a separate bug being fixed on its own
track). Still, it exposed that there is NO layer anywhere that can say "no,
this write belongs to the other machine — here's who to ask." Most endpoints
never check anything; they just write a local file on whichever machine the
request happened to hit.

## The fix — sort every save into one of four buckets

Instead of one on/off switch for all saving, every kind of save gets a bucket:

1. **Machine-local** — notes a machine keeps about itself (its attention
   items, its improvement queue, its own sessions' build context). Always
   allowed, on every machine. These already have their own way of staying in
   sync across machines, and each entry must NAME that sync story before it's
   allowed in this bucket — no story, no bucket.
2. **Session-scoped / topic-scoped** — state about one conversation. Allowed
   only on the machine that actually OWNS that conversation (the pool already
   tracks exactly one owner per conversation). When there's no ownership
   record, the two flavors deliberately differ — matching what each does
   TODAY, so neither gets riskier: for **session** notes (a purely local
   helper session, one that was never pooled), no record means it's really
   this machine's own business, so it's allowed — you're never blocked from
   serving your own user because of a missing bookkeeping record. For
   **conversation-topic** notes, no record means "fall back to the old rule"
   (only the lease-holding machine saves) — because letting EVERY machine
   save an unclaimed topic's notes would put two writers on the same file,
   the exact clash this whole design promises never to create.
3. **Cluster-shared** — genuinely shared stuff (the lease itself, job
   schedules). Rule unchanged: lease holder only. This never gets looser.

And when a save IS refused, it's refused **instantly and clearly**: a proper
"409" answer that says which bucket, why, who the real owner machine is, and
how long to wait before retrying. Never a hang, never a vague error, and a
refused save touches nothing (no half-created items, no wasted AI calls).

## Details worth knowing

- **The ownership check is instant.** It reads a small in-memory table that's
  kept up to date every time conversation ownership changes hands — it never
  reads disk or the network to answer. That's how "answer in under 2 seconds"
  is guaranteed whenever the process itself is healthy.
- **One real bug found while writing this:** the "build context" notes from
  both machines were being written into the SAME file, which both machines'
  git-sync would then fight over forever. Fixed by giving each machine its own
  file (the machine's ID is in the filename).
- **The hang mystery gets instruments, not a patch.** This spec adds a gauge
  that measures when the process's engine stalls, so future hangs are
  attributed to the real cause instead of blamed on the write rules. Actually
  fixing the stalls is its own separate work item.
- **Rollout is careful.** It ships in "watch-only" mode first: the old rules
  keep enforcing while the new system just logs what it WOULD have decided.
  Only after days of clean logs — and only after every single endpoint that
  writes anything has been inventoried and classified — does it take over.
  Both dev machines flip together. Single-machine setups notice nothing at
  all.

## Where this stands

Round-1 review found 20 issues (5 must-fix); all were folded. Round-2 review
then found 10 more (1 must-fix). The must-fix was real: the round-2 draft
accidentally let every machine save an unclaimed conversation-topic's notes —
contradicting its own "never two writers" promise. This round-3 revision
fixes that by splitting the "nobody owns it" rule per flavor (see bucket 2
above), and also: corrects a wrong filename the round-1 review itself had
introduced (the improvement-queue endpoint writes `action-queue.json`, not
`evolution-queue.json`); stops citing a cleanup timer that turns out to be
declared in the code but never actually running; requires the "stays in
sync" story to cover the FILE level too (git-synced shared files get
excluded from sync as part of wave 1); and pins down several smaller details
(where the machine ID in filenames comes from, what happens to saves during
the brief boot window, alerting when the checker itself breaks). Awaiting
round-3 review.
