# Age-Timeout Kill Back-off — ELI16 overview

## What this change is, in one sentence

When the part of instar that watches sessions decides an old, idle session "should be cleaned up," but a safety guard says "no, keep it" — this change makes the watcher *remember that answer for a while* instead of asking the same question every 5 seconds forever.

## The story (what went wrong)

Every 5 seconds, the SessionManager looks at each running session. If a session is older than its age limit and looks idle, it asks the kill-authority: "can I shut this one down?" A smart guard (called the KEEP-guard) then checks real signals — did the user message this session recently? is it tied to a live chat topic? does it have an open promise to follow through on? If any of those are true, the guard answers "keep it," and the session correctly survives.

The bug: the watcher threw away that "keep it" answer. Five seconds later it asked the exact same question about the exact same session, got the same "keep it," threw it away again… on and on. On 2026-06-05 this produced **17,503 identical "Requesting kill" log lines** for about four legitimately long-lived sessions, plus wasted CPU that, to the operator, *looked* like "the machine is under heavy load." Nothing was ever actually killed — it was pure churn.

## What already exists (and stays exactly as it is)

- The KEEP-guard and all its signals (recent user message, topic binding, open commitments, etc.) — unchanged. It remains the **sole authority** over *which* sessions get shut down.
- The 5-second monitor tick — unchanged. Other safety checks depend on it.
- A genuinely abandoned session (old, idle, and *no* keep-reason) — still gets shut down on the very first ask, exactly like before.

## What's new

A small, self-contained bookkeeping helper, `AgeKillBackoff`. After the guard says "keep it," the helper records "don't re-ask about this session for the next 10 minutes." So the watcher asks roughly **6 times an hour instead of 720** — a 120× reduction — and the flood collapses to a single, clear log line: *"over age but KEPT (reason); backing off re-checks."*

It's a pure, well-bounded ledger: an injectable clock (so it's easy to test), a hard cap on how many sessions it tracks (so memory can't grow without limit), and it forgets a session the moment that session is actually killed or gets newly engaged by the user.

## The safeguards, in plain terms

- It **never** changes *which* sessions die — only *how often the watcher asks*. The guard is still in full control.
- The back-off is **time-bounded and per-session**: if a kept session's reason to live lapses, it gets re-checked after the window and cleaned up then if it's now truly abandoned. No session is kept alive *by* the back-off; the back-off only silences redundant *questions*.
- It's fully reversible from config: `ageKillBackoffMinutes: 0` restores the old every-tick behavior instantly, and the default (10 minutes) lives in code so every existing agent gets the fix automatically on update.

## What you actually need to decide

Whether 10 minutes is the right default quiet-window between re-checks of a kept session. Longer = quieter logs but a slightly slower re-check of a session whose keep-reason just lapsed; shorter = faster re-check but more log lines. 10 minutes turns 720 asks/hour into 6 while still re-evaluating a session well within a normal idle-cleanup horizon — which is why it's the proposed default.
