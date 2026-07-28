# ELI16 — Why a "paused" agent was still burning CPU

Every agent has a little local AI model it uses to understand and search its own
memories (it turns text into number-vectors). Loading that model is slow-ish, so
once it's loaded we kept it in memory, ready to go. Sounds efficient — except the
engine that runs the model (onnxruntime) keeps a team of worker threads, and those
threads don't actually go to sleep when there's nothing to do. They *busy-wait* —
they keep spinning in a tight loop checking "is there work yet? is there work yet?"
— which burns real CPU even when the agent is completely idle.

I measured it live: a loaded-but-idle model eats about 3.6% of a CPU core on a quiet
machine, and I'd earlier seen it hit ~44% on a busy one. Now picture five agents on
one computer — Echo, AI Guy, Dawn, and a couple more — each keeping its own model
loaded and spinning while they're all supposedly "paused." That's a big chunk of a
machine's CPU spent on literally nothing. It's one of the real reasons the box felt
overloaded.

The fix is simple: if an agent hasn't needed its memory model for a while (5 minutes
by default), unload it — tell the engine to release its worker threads — and just
reload it the next time it's actually needed. Loading takes only a second or two,
and memory searches aren't the kind of thing that needs to be instant, so paying a
one-time second when you come back from a long idle is a great trade for not burning
CPU the whole time you're idle.

I verified the whole cycle on the real model, not just in a unit test: idle CPU went
from 3.6% down to **0.0%** after unloading, and after reloading, the model produced
the *exact same* number-vector for the same text (so nothing is lost or corrupted by
unloading and reloading). I also made sure it's safe: if the agent IS in the middle
of a big batch of memory work when the timer goes off, it won't yank the model out
from under it — it waits until the work is done. And if an operator ever wants the
old "keep it loaded forever" behavior, they can set the idle time to zero to turn the
feature off.

The upshot: agents that aren't doing memory work stop wasting CPU on a spinning
model. Active agents are unaffected — every time they use memory, the clock resets,
so the model stays loaded as long as they keep using it. It only unloads during
genuine idle, which is exactly when that CPU should be free for something else.
