# Skill Learning Sentinel — the plain-language version

**What it is.** When you ask me for the same kind of thing a few times, I should stop reinventing how I do it.
This feature watches for that, writes the procedure down as a skill (a reusable recipe I follow), fills it with
your corrections and preferences from the times I did it, and then keeps score of whether the skill actually
works. Good skills get small fixes over time; bad or unused ones get shelved (never deleted). You don't have to
do anything day to day; you can see all of it on the console's "Learned" page.

**Why it matters.** Preferences are how you like things. Memory is what I know. This is the third leg: how I do
things, kept the same every time. That is most of what "coherent" means.

**How it decides to make a skill.** Not after any big task (that is how Hermes ends up with two to four new
skills a day). Only when the same request shows up at least three times, on at least two different days, in at
least two different conversations, and at least one of those times demonstrably went well. Only your own
verified messages and my own actions go into the draft — never text someone forwarded to me, never the contents
of a page I fetched. That makes planting instructions in a skill much harder, not impossible, which is why every
new skill also gets a second opinion from a different model family and, during the trial, waits for your tap.

**How it keeps itself honest.**
- "Went well" is never just silence. A run only counts as good if you acknowledged it, or asked for the same
  thing again later without complaint. No signal means "unknown," and unknown never counts in a skill's favour.
- Every use of a skill is logged, together with whether you had to correct me afterwards. That gives each skill
  a score, and the score is per version, so a bad fix gets rolled back on its own.
- Fixes are proposed by a different model family than the one that wrote the skill, so it is not grading its
  own homework. New skills get the same second opinion before they exist.
- Nothing is ever deleted or merged. Old versions are kept. A shelved skill has a one-tap restore.
- If you edit a skill by hand on any machine, I stop touching it.
- No hard caps on how many skills I may learn (an earlier draft had "one a day, four a week, forty total"; you struck
  them). Instead, whether a recurring request deserves a skill is a judgment I make each time, weighing how strong the
  pattern is, what my skill list already covers, and the measured cost of carrying one more — inside a floor that
  never moves: at least two real occurrences and one run that demonstrably went well. If I start creating a lot in
  one week you get told, with my reasons, but nothing refuses.
- Shelving a skill is a judgment too, with a floor: never on fewer than three measured runs, never deleted.
- Every judgment call it makes is recorded with its reasoning; if that record cannot be written, it does not act.

**How it rolls out, and why this one will not stall.** It ships off, and it carries a dated trial plan from day
one. First it runs on a throwaway test agent. Then on my development agent in "shadow": it logs "I would have
created X" without creating anything, and you get a one-tap agree/disagree on each sample, so we can see whether
the trigger fires at a sensible rate. Then it goes live on the dev agent with one safeguard: while the trial is
running, a brand-new skill waits for a one-tap confirmation from you before it switches on. That tap goes away
once the trial proves the gate. The test at that stage is simple: runs that use a learned skill must not get
corrected more often than the same request did before the skill existed. Only after that holds, and a recurring
review says so, does it become a default anywhere else. Each stage has a tracked promise with a deadline that
nags me, the weekly analyst report names any stage that has expired unproven, and the plan is checked by a gate
before the spec can even be approved.

**What you'll notice.** Nothing, by design. I will only raise a notice if a skill has to be shelved because it
was making things worse, if something structural is stopping me from writing one, or if the measuring itself
has gone blind.

**Two things that have to land first.** The master copy of skills (the "canonical" folder Instar renders into
each coding framework) was designed in May but the step that fills it on existing agents never shipped, and the
log of skill uses was writing broken rows. Both repairs are slice 0 of this work. And the correction sentinel
(how you like things) has to be switched on on my development agent for the trial, which I did today.

**Tracked.** The approval and the first build step are one tracked promise (CMT-042), so the May postponement this
spec closes is linked to a dated owner rather than left in prose.
