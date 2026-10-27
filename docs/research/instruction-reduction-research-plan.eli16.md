# Instruction Reduction — Plain-Language Version

**The problem.** Every Echo session starts by reading one big instruction file, measured at about 147,000 tokens. Job sessions also run start-up add-ons and end up around 240,000. That costs money and time, and it crowds out room for real work.

**First result.** Slim instructions for scheduled jobs, even with a one-line list
of every feature, failed the agreed no-degradation test. They saved about 65%
of input tokens, but missed the worktree reaper's authority in all five sampled
cases and regressed on two feature-use cases. Echo's live instructions have not
changed. The seed and automatic-loading ideas remain research candidates.

**What is in the file.** We measured it. Most of it (about 70%) is a reference manual: "here is feature X, here is how to call it". More than a third describes features that are switched off on most agents. About 15% is history: the story of why a rule exists. The core rules, such as "never paste a live password", "always reply on Telegram" and "don't quit because the conversation is long", are a small part.

**Good news: some of the tools already exist.** Instar already has a function that writes a short "seed" instruction file, but new agents don't use it. It also has a searchable capability index (the Self-Knowledge Tree), a Playbook that picks context by trigger, and a memory picker that ranks what to load. The plan builds on these before writing anything new.

**The options we will test.**
- **Seed (Justin's idea):** a small file that is always loaded. It holds who the agent is, the core rules and the hard safety walls, plus a table of contents: "if the user asks about X, load section Y".
- **Seed plus automatic loading:** the same seed, but a hook reads each incoming message and loads the matching sections automatically, so the agent doesn't have to remember to look.
- **Lean job context:** scheduled jobs load only the sections they need.
- **Ranked loading:** a model picks the most relevant sections for each conversation.
- **Simple trimming:** keep one file, but drop the switched-off features and the history.

**How we prove nothing gets worse.** We write fixed tests before trying anything:
- Does the agent still find the right feature when a user asks something, without being told?
- Does it still follow every safety rule? For these the bar is zero new failures, scenario by scenario. A better average is not enough.
- Does it stay coherent over long sessions, including after its memory is compressed?
- Is real work still as good?

Graders don't know which version they are scoring. We run each safety test hundreds of times so we can show the failure rate is below about 1%.

**How we roll it out.** Offline tests first. Then a "shadow" run, where the new version watches real conversations without acting, for at least a week. Then a few low-risk jobs. Then one conversation, then all of Echo, and the wider fleet last. One setting switches everything back to the full file. Any safety slip switches it back automatically.

**When we stop.** We drop an option if it breaks a safety rule twice. We drop the whole effort if nothing saves at least 40% while passing every test. We pause if real-world grading shows a problem the tests missed.

**Two decisions Justin made.** First, no drop allowed: a slimmer version passes only if it finds and uses the agent's features at least as well as the full file does. Second, features that are switched off stay listed, with what they do and how to turn them on, so the agent can still offer to switch one on. Only the long how-to text is loaded when needed.
