# Codex Full Parity — the plain-English version

**The goal:** make Instar work just as safely and smoothly when its "brain" is Codex (GPT) as it does when the brain is Claude.

**What we already did:** we installed all the safety guards onto Codex agents — like fitting a house with smoke detectors and door locks.

**What we just learned by actually living in the house (driving codey for real):** the guards are mounted on the wall, but several aren't actually switched on. Here's the punch list, simplest first to explain, but ordered by importance in the real spec.

### The big one: the guards need a human to "arm" them, and a robot can't

Codex will only run a guard that someone has personally clicked "I trust this" on. Instar has no way to flip that switch by itself. So a brand-new Codex agent has every safety guard dark until a person clicks through a prompt — and a self-running agent can't click. The guards that DO work on codey only work because that trust was granted by hand earlier. **This is the #1 fix:** give Instar a way to arm its own guards automatically. (There are a few possible ways; one needs a bit of reverse-engineering, so I want a second-opinion review on it.)

### The end-of-turn review crew is the wrong crew

When a turn ends, three checkers are supposed to run: a tone/coherence check, an anti-confabulation check, and a scope-drift check. On Codex we accidentally swapped one of them out for a checker that belongs at a totally different moment — and that misplaced one just sits there doing nothing. Fix: put the right three back, and move the misplaced one to where it actually belongs.

### One checker only speaks "Claude," not "Codex"

The anti-deferral checker reads the data in Claude's format. Codex hands it the same information with different labels, so the checker shrugs and does nothing. (I proved this directly — fed it both formats and watched it work for Claude, ignore Codex.) Fix: teach it to read both, exactly like we already did for the dangerous-command guard.

### The dashboard puts a Claude sticker on a Codex car

codey is Codex-only — it literally can't run Claude — yet the dashboard labels its sessions "haiku"/"sonnet" (Claude names). Under the hood it IS using the right GPT model; it just saves the generic nickname instead of the real model name on the record. Fix: save the real model name. (This is exactly what you asked me to check.)

### Instar couldn't find Codex on this kind of computer

Codex was installed through a tool called asdf, which tucks programs in a folder Instar doesn't look in — so Instar said "no Codex here" even though it was sitting right there. Fix: also look in the asdf folder. Helps everyone who uses asdf.

### A few smaller ports + the memory-after-compression redesign

A couple more Claude guards are worth bringing over, and the "remember who you are after the chat gets auto-compressed" feature needs a different approach on Codex (the event we'd use can't carry the information back — I checked, so I didn't ship dead weight).

---

**What's NOT broken (the good news):** a huge shelf of Instar features just works on Codex unchanged, because they live in the shared "server brain," not the engine. Scheduler, private views, tunnel, coherence gate, secret drop, attention queue, commitments, publishing — all confirmed working live on codey. Token usage tracking is even fully Codex-aware already, with real numbers flowing.

**What I need from you:** your one approval on this fix-list, and ideally trigger the cross-model review on the trickiest piece (the auto-arming-guards one). After that I build each fix, test it three ways, and prove it live on codey before it ships.

---

## Update: the review round (2026-05-25)

After I drafted this plan, I ran it past five reviewers (security, adversarial, integration, scalability, and a "lessons-aware" one that checks the plan against every hard lesson we've learned). The review earned its keep — it caught me in two places where I'd said "done" too early, plus a couple of real bugs in code I'd already committed:

- I'd claimed two of the review-checkers "already work on Codex, no code needed" because Codex's program lists the data field they read. The review pointed out: listed-in-the-schema isn't the same as actually-filled-in-when-it-runs. Downgraded to "looks right, not yet proven" — I have to capture a real Codex turn and confirm the field isn't empty.
- The plan let the hook-rewiring ship on its own. That's dangerous: rewiring makes Codex distrust the guards until they're re-armed, so shipping it before the auto-arming fix would leave existing agents *less* protected. Now they ship together.
- The headline (auto-arming) got firm guardrails: don't use the machine-wide policy channel; prove the guards are scoped to just this one agent before shipping; guarantee a human can always turn a misbehaving guard off; and add a check that actually confirms the guards still block, live.
- Two real bugs in already-shipped code got fixed on the spot: a fallback that silently did nothing in the real environment, and a missing cache that made startup do extra work.

Net: the plan is the same shape, but honest about what's proven vs not, and safer about how it ships. The full reviewer findings are in the convergence report linked in the frontmatter.

## Update: the two follow-ups, done (2026-05-25)

Both small follow-ups are now closed:
- **Soup check (B1):** I drove a real Codex turn and grabbed exactly what the two end-of-turn checkers receive. The "last thing the agent said" field came back filled in with the real reply — so those checkers genuinely get fed on Codex. Confirmed, no code change needed.
- **Real-building canary (C4):** the drift alarm now also reads the ACTUAL installed config on an agent and confirms the safety guards are present AND switched on (trusted) — catching a clobbered config or a dark/untrusted agent, not just blueprint mistakes.
