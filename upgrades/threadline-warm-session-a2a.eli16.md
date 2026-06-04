# Warm sessions: how rapid agent-to-agent threads stop cold-starting

## The problem in one breath
When another agent and I have a back-and-forth, each of my replies used to run as
a **throwaway**: it answered once and exited. So when a second message arrived a
moment later, there was nothing alive to hand it to — I'd cold-start a brand-new,
memoryless reply. The turn-based fix I already shipped (#746) handles the *slow*
case by re-opening the same conversation with `--resume`. But *rapid-fire* (a few
messages in seconds) still cold-started, and on a fresh thread could even hit a
30-second spawn cooldown.

## A real bug I found while grounding this
While reading the code I found that even when a reply session *was* briefly alive,
my "type the next message into it" path was being **refused every single time**.
The safety check only allows a short list of program names, and it lists `claude`
— but on this Mac the live program actually shows up as **`claude.exe`**. So the
check never matched, and agent-to-agent live-typing has been **dead on arrival on
macOS**. One-line fix: allow `claude.exe`. (This is exactly why "ground before you
assert" matters — the feature looked wired but wasn't.)

## The fix (reuses what's already shipped)
Keep the reply session **alive** between messages — exactly like my normal chat
sessions with you, which stay open and get messages typed into them:
- The first message from a peer spawns a **persistent** reply session (not a
  throwaway), tracked in a small pool keyed by the thread.
- The next message is **typed into that same live session** (now that the
  `claude.exe` fix lets it through) — no cold-start, no cooldown.
- The pool has tight caps (3 sessions total, 1 per peer) and a 10-minute timeout
  so a chatty peer can't pin a pile of live sessions; when one is evicted, the
  **next message just falls back to the proven `--resume` path** — nothing lost.

## The nice surprise: the security question dissolved
An earlier draft worried about letting "verified" peers into a **single shared**
listener — one peer's content could mix into a session handling others. The new
design gives **each conversation its own private session**, so there's nothing
shared to leak. The trust gate stops being a secrecy control and becomes a simple
"who's allowed to keep a session warm" resource control. Injected follow-ups also
now get the same untrusted-data grounding wrapper that spawns/resumes already use.

## Works for every framework — not just Claude (your note)

The first cut leaned Claude-specific in two spots, and both are now routed through
the framework abstraction so a Codex or Gemini agent gets the same warm sessions:
- The "is this process safe to type into?" allowlist used to be hardcoded to
  `claude`/`claude.exe`. It's now **derived** from a per-framework registry
  (`claude → claude/claude.exe`, `codex → codex`, `gemini → gemini`), typed so the
  compiler refuses to add a framework without giving it a process name.
- The warm worker now launches in **the local agent's framework**, not always
  Claude — so on a Codex agent it spins up a Codex session, with Codex's own
  resume mechanism.

And — the part you actually asked for — this is enforced by the **review process**,
not by remembering: a CI test fails if any framework lacks coverage or the allowlist
drifts, and the `/instar-dev` precommit gate makes any change to the launch/inject
layer state, in writing, whether it works for Codex and Gemini. So "works for all
frameworks" is now a gate, not a good intention.

## How it ships
Dark on the fleet, **live only on the development agent**, behind a flag, with the
proven resume path as the fallback if a warm session is ever evicted. With the flag
off, behavior is byte-for-byte the current cold-spawn path. Full unit + integration
+ e2e tests cover both sides: warm inject when enabled, byte-identical cold-spawn
when disabled, peer-conflict → cold fallback, and evict → resume continuity.
