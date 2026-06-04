# Catching the "busy but useless" process

## The one-sentence version
Last fix (#722) taught the cleanup robot to ignore a *frozen* leftover program. But a leftover program can also be *spinning uselessly* — burning the engine while going nowhere — and that one still looks "busy." This change makes the robot **notice and write down** those cases (without touching anything yet), so we can see how often it happens before we ever let it act.

## Back to the garage
Earlier rule: "don't tow a car just because it has an engine — only if the engine is also cold (off)." Good for the junked car with a dead battery.

But what about a car parked in its spot with **the engine revving, nobody inside, going nowhere** — a stuck throttle? Its engine is hot, so the "is the engine cold?" test says *keep it*. Yet it's just as useless as the dead one, and it's burning fuel (CPU) and making noise (load) the whole time.

This change doesn't tow that car. It puts a **note on the windshield**: "spot occupied by a revving-but-empty car for 10+ minutes." Collect enough notes and we'll know whether stuck-throttle cars are a real problem worth a tow rule — backed by data, not a guess.

## What it actually does
- Watches for a session that is **sitting idle** (at its ready prompt, transcript not growing) while a child program **keeps burning CPU**.
- After that's been true for a while (a dwell, ~10 minutes), it writes one line: `busy-orphan-suspected`.
- When the situation clears, it writes `busy-orphan-cleared`.
- That's the whole feature. **It never reaps, kills, nudges, or notifies.** Pure note-taking.

## Why note-taking first (instead of just towing)
The one honest reason *not* to tow a revving car: maybe the driver started it on purpose to warm it up and stepped away — i.e. an agent legitimately kicked off a real background job and went back to its prompt. Telling those two apart reliably is hard. So instead of risking a wrong tow, we **measure first**: gather real examples, learn the signatures, and only then design a safe auto-action. That's the instar way — observe, then act.

## The safety rails
1. **Changes no decisions.** The keep/kill logic is byte-for-byte the same; this only adds an audit line.
2. **Only under load**, only when CPU is actually measurable, only after a real dwell — never on a hair trigger.
3. **One note per episode**, not per tick — no log flood.
4. **Dark everywhere except me** (the development agent), so it proves itself on a real loaded machine first.

## Why it matters
Together with #722 this closes both halves of "a process pins an idle session": the *idle* leftover (#722 can now reclaim it) and the *busy* leftover (this makes it visible). You can't responsibly manage machine load you can't see — this is the seeing.

---

**Rendered (verified HTTP 200):** https://echo.dawn-tunnel.dev/view/a6ad4a97-c59b-4a61-81c8-4d2aa8d3d7b4?sig=333db8be8c2b9624668753699e48aaa03a5b208ae963c841293ae4ba4ec0c5f7
