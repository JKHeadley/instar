# Where do inbound messages actually arrive on this machine? (ACT-1217)

**Status: substantially answered, with one link unverified and named as such.**

The `inbound-message-recording-gap` spec says "the recording code is not broken —
it is on a path that is not being used" and treats *which* path as unknown. That
unknown blocks fleet default-on. This is the investigation.

---

## What is VERIFIED

**0. Which machine this is.** `hostname` → *Justin's MacBook Pro*; `GET /pool`
lists `Laptop` (`m_cc2ec651…`) and `Mac Mini` (`m_4cbc0d4a…`), both online. This
session runs on the **Laptop**. **Earlier revisions of the spec named these
backwards** — they said the measurements were taken on the Mini and that the
Laptop was the router. The reverse is true, and the error stood all day.

**1. This machine is on standby; it does not hold the serving lease.**
`GET /health` → `multiMachine.syncStatus`: `holdsLease: false`,
`leaseHolder: m_4cbc0d4a0c557cf7e221882f9b42518f`, `splitBrainState: clear`.
Corroborated independently in `logs/server.log`, which repeats
`StateManager is read-only (this machine is on standby)`.

**2. The forward route exists here and does call the logger.**
`router.post('/internal/telegram-forward', …)` at `src/server/routes.ts:20385`;
`ctx.telegram.logInboundMessage({…})` at `:20570`, inside that handler's body
(the next route registration is `:20975`).

**3. This machine's lifeline is running.** `launchctl` shows `ai.instar.echo`
alive as `instar-boot.cjs lifeline start`, and `TelegramLifeline.ts:1577` posts
to `/internal/telegram-forward`.

**4. A cross-machine delivery path exists that injects WITHOUT logging.**
`src/commands/server.ts:20722` calls `injectTelegramMessage` from an `onAccepted`
handler whose own comment at `:20643` reads:

> *Owner-side bridge (§L4 handoff): a forwarded message landed → spawn/resume the
> local session for the topic so the conversation continues on THIS machine …
> a `deliverMessage` only arrives from a router peer.*

That call site is one of the three id-less callers the spec already documents.
**It does not call `logInboundMessage`.**

**5. Zero forward-route activity here.** `grep -c "telegram-forward"
logs/server.log` → **0**, over a log covering 09:47Z→14:00Z today (9,883 lines
from today).

---

## The most likely explanation

The router peer — **the Mac Mini** — receives the Telegram message through **its** lifeline and
**its** `/internal/telegram-forward` — which logs it **there** — then forwards a
`deliverMessage` across the mesh to whichever machine runs the session. This
machine injects it via the owner-side bridge, which never touches the local
logger.

That would mean the messages are not lost globally; they are recorded on the
router peer, while the session composing replies lives here and reads local
history that has none of them. Which is exactly the symptom: **one-sided memory
on the machine that does the talking.**

---

## What is NOT verified, and why

**The log window contains no inbound Telegram message at all.** `session-pool`
and `deliverMessage` both appear **0** times in today's log — but so does any
inbound message, because the operator's last message predates the current log.
So I have **not** observed a message traversing this path; I have shown the path
exists, that the alternative path is unused, and that this machine's role makes
the cross-machine route the plausible one.

**I have not read the router peer's database** to confirm the rows are there.

Naming both gaps rather than rounding up to "answered" — the defect under
investigation exists precisely because someone assumed a path was in use without
checking.

**The cheap way to close both:** send one Telegram message to this topic and
watch `logs/server.log` on both machines. That is a two-minute check requiring an
inbound message to exist, which is the one ingredient this investigation could
not manufacture.

---

## What it changes for the fix

**It strengthens the seam choice rather than undermining it.** If delivery
reaches this machine through a cross-machine bridge that bypasses the intake
route, then the injection seam is not merely *a* verified point — it is the
**only** point both local and forwarded delivery share. Recording anywhere
upstream would have missed exactly the case that produced this bug.

**It sharpens the spec's §1.** "On a path that is not being used" is true; the
fuller statement is that this machine is a session-pool *worker* rather than a
router, so its intake route is legitimately idle while its sessions are busy.

**It does not close ACT-1217.** The remaining step is the two-minute live check
above.
