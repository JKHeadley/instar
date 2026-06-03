# Why the reaper got smarter about "busy" sessions

## The one-sentence version
Before, the cleanup robot thought a session was *busy* if it had **any** helper program still attached — even a frozen, do-nothing one. Now, when the machine is overloaded, it also checks whether that helper is *actually using the CPU*. A frozen helper no longer keeps a dead-idle session alive and hogging the machine.

## Picture it
Think of a parking garage that only tows cars when it's full. The old rule: "never tow a car if its engine is installed." Trouble is, a junked car with a cold, dead engine *still has an engine installed* — so it sat there forever, taking a spot while the garage overflowed.

The new rule (only when the garage is full): "don't tow a car just because it has an engine — tow it only if the engine is also **stone cold** (not running) AND the driver's seat is empty AND nothing's happening inside." A car that's actually running, or has someone in it, is never touched.

## What changed, precisely
- The reaper used to keep a session whenever a child process **existed**.
- Now, **under CPU load only**, it also asks: did that child burn any CPU recently?
- If the child is **flat (≈0 CPU)** *and* the session is sitting idle at a ready prompt *and* its transcript isn't growing → it becomes reclaimable.
- If the child is doing real work (CPU rising), or the session might be mid-task → it's kept, exactly like before.

## The safety rails (why this won't kill your work)
1. **Off when the machine is calm.** Zero change unless CPU pressure is real.
2. **Never kills on the CPU check alone** — it still has to pass the "is it truly idle?" proof and the slow, repeated-confirmation + budget gates.
3. **Can't measure? Keep it.** First look, missing data, weird readings → always keep.
4. **Only the cleanup robot changed.** The guard that stops *other* things from killing your sessions is untouched.
5. **Dark by default.** Off across the fleet; on only for the development agent (me) so I can prove it on a real loaded machine first.
6. **Leaves a paper trail.** Every time it relaxes the rule it writes a line you can read in `logs/reaper-audit.jsonl`.

## Why it matters
Idle sessions with a stuck helper (a hung MCP server, a wedged `codex` job) were quietly piling up and starving the machine — which is what makes new sessions fail to spawn and messaging go silent. This lets the reaper finally reclaim exactly those, without ever risking a session that's actually working.

---

**Rendered (verified) view:** _set below after creating the tunnel view._
