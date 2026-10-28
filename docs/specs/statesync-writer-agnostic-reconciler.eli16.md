# Why four of my memory stores never showed up on my other machines — and the fix

## What this is about

When I run on several machines, I am supposed to be ONE agent with ONE memory. Seven kinds
of memory are set to copy themselves between my machines: lessons I learn, action items,
who my verified operator is for each conversation, my knowledge library, the people I know,
registered users, and learned preferences.

A review on 2026-10-25 noticed that the first three copy themselves fine, and the other four
(knowledge, people, users, preferences) have NEVER produced a single copy on any machine. Same
plumbing, same switches turned on. That looked like a broken pipe.

## What I actually found

I traced it live on all four machines. The pipe is fine. The four stores are simply **empty
everywhere**: no knowledge documents ingested, no people recorded, no users registered, and
the preference-learning loop has not yet turned any correction into a preference. Nothing was
ever written, so nothing was ever copied.

But the trace found a real problem that WOULD bite the moment something is written. A store
copies a record only when the write goes through one specific object living inside my server.
Most of the writers live somewhere else:

- The knowledge library is filled ONLY by the command-line tool `instar knowledge ingest`,
  which runs as a separate program with no connection to the copier. Knowledge could never
  have copied, even with data.
- People, users, lessons and action items can also be written by command-line tools (and
  users by a dashboard route that makes its own short-lived user manager). None of those
  writes reach the copier.

## The fix in one sentence

Instead of trusting every writer to go through the copier, the server now **looks at the
store files on disk every ten minutes and copies anything new or changed** — whoever wrote it.

## How it works

- A small component, the reconciler, wakes 90 seconds after boot and then every ten minutes.
- For each switched-on store it reads the store's file fresh from disk, builds each record
  exactly the way the live copier does, and compares a fingerprint with what it has already
  copied. Same fingerprint: nothing to do. New or changed: copy it through the same copier,
  with the same privacy trimming and the same on/off switch.
- After a restart it learns the fingerprints from my own copy log, so a restart does not
  re-copy everything. It re-reads that log once a day, which also brings back any record that
  aged out of the log.
- The live copier tells the reconciler about every copy it makes, so the two never copy the
  same record twice.

## The safeguards, in plain words

- **Off means off.** A store that is switched off (the default for every agent except my own)
  is not even read. Single-machine agents see no change beyond what the live copier already
  writes.
- **A copy only counts when the log accepted it.** If the log refuses (too busy, locked, a
  malformed record), nothing is marked as copied and it is tried again next round.
- **It never touches a write.** It runs on its own timer and only reads files.
- **Deletes only when someone really deleted.** For the people store and the knowledge library,
  the delete command now writes a short note ("record X was deleted", no names or details in it)
  before and after it removes the record. The reconciler copies a deletion only when it finds a
  finished note AND the record is gone from disk. A record that just vanished, say because two
  command-line tools saved the file at the same moment and one overwrote the other, is never copied
  as a deletion; the other machines simply keep it. The notes are ordered by the server's own
  replication clock, not the wall clock, so a clock change can't confuse them. For users, lessons
  and action items, deletions made through the server still copy as before; deletions made from the
  command line don't yet (a related bug, fb-9ac43374-07b, has to be fixed first).
- **Copies never pretend.** A copy the reconciler makes does not claim to have seen the other
  machines' versions. If another machine holds a genuinely different version, both are kept and the
  difference is flagged rather than one silently overwriting the other. If both machines hold exactly
  the same thing, it counts as one record (and any old "conflict" between identical copies closes
  itself, recorded as such, not as your decision).
- **Not on git-synced agents.** On an agent that syncs its files with git, those store files already
  travel by git, so the reconciler leaves them alone. My machines don't use git-sync.
- **No loops.** At most 40 copies and 20 deletes per store per round; a store that keeps
  failing is retried less and less often (up to once an hour), and after a full day of failing it
  stops and leaves one item for me to look at; a record that would be copied again every round is
  paused and noted.
- **Same privacy as before, plus one fix.** Learned preferences now have credential-looking
  text redacted on both the live path and this one (the live one was missing that step).

## What you can check

- `GET /state/reconcile` shows, per store, how many records it copied, deleted, found
  unchanged or saw refused, and whether a store is backing off or skipped.
- Switch: `multiMachine.reconcile.enabled: false` turns it off on the next round, no restart.

## What the proof will look like

I will ingest this very document into my knowledge library on the Studio with the
command-line tool, and record my operator's own contact entry the same way. Both should
appear in the copy logs on the Mini, the Laptop and the Mama PC within one round. For users
and preferences there is no real record to send yet and I will not invent one; those are
proven by automated tests that drive the same code.

## What you need to decide

Nothing. It changes nothing for agents whose stores are off, changes no user-facing output,
and can be switched off with one setting.
