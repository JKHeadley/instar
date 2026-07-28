# Why agent-to-agent conversations can now actually remember

## The one-sentence version
When another agent sends me several messages over a conversation, each of my replies used to run as a throwaway that finished and forgot everything — so the next message met a stranger. Now I give each reply session a **known name tag** when it starts, write that tag down, and on the next message I **re-open the exact same conversation by its tag** — so I pick up right where we left off, with the full history.

## What was broken (proven live)
A real round-trip with Dawn showed every follow-up still cold-spawned a memoryless session. The deep reason: each reply ran as a headless one-shot Claude that **never reports its own session id back to me**, so when it finished I had no handle to reconnect to. My earlier fix made the router *try* to reconnect, but there was nothing to reconnect to.

## The fix (deterministic, no guessing)
Claude lets you (a) **set** a session's id when you launch it (`--session-id <uuid>`) and (b) **re-open** a session by that id later (`--resume <uuid>`). I verified both directly: setting an id creates the transcript under that exact id, and resuming it reloads the whole prior conversation (I planted a secret word in turn 1 and the resumed session recalled it).

So now:
- When a peer's first message spawns a reply session, I **mint a fresh id and pass it as `--session-id`**, then store that id as the thread's resume handle.
- When the next message arrives, I spawn with **`--resume <that id>`** so the session reloads the full prior transcript and continues — and I send it only the new message (the transcript already holds the history, so re-pasting it would just duplicate it).

## The safety rails
1. **Additive + off by default.** The new options do nothing unless set. Every other kind of session (jobs, your topic sessions, Codex) is byte-for-byte unchanged.
2. **Claude-code only, and the two flags are mutually exclusive** — a launch either sets a new id or resumes one, never both.
3. **A stale id can't wedge me.** If a transcript no longer exists, the existing resume-crash guard falls back to a fresh spawn instead of hanging.
4. **The reply path is untouched.** Setting/resuming the conversation id doesn't change tools or permissions, so the agent still replies normally over the secure channel.
5. **Built on the shipped foundation** (the router already finds the live session + carries the real session name); this adds the missing piece — the real, resumable id.

## What it does NOT yet fix
The *rapid-fire* case (three messages in ten seconds, while the reply is still being written) still isn't smooth — that needs the bigger persistent-session work. This fixes the realistic **turn-based** conversation (you reply, I reply, you reply a minute later), which is exactly what the agent-to-agent feedback migration needs.

---

**Rendered (verified) view:** _set below after creating the tunnel view._
