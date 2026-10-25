# Side-effects review — dashboard session badges: platform on the WebSocket list, tooltips, legend

Tier 1. Topic 112490. Files: `src/server/sessionPlatform.ts` (new), `src/server/routes.ts`, `src/server/WebSocketManager.ts`, `src/server/AgentServer.ts`, `dashboard/index.html`, tests.

Decision point? No. The change derives a display field (`platform`) and adds tooltips and a legend. Nothing gates, blocks or filters any message or action. The door + model button keeps reading `platform` from `GET /sessions`, whose output is unchanged.

1. **Over-block** — None; no blocking logic.
2. **Under-block** — Not applicable. Remaining gap: WhatsApp and iMessage sessions still resolve as headless on both surfaces, exactly as `GET /sessions` already did; this change does not widen or narrow that.
3. **Level-of-abstraction fit** — The derivation now lives in one helper used by both session surfaces instead of inline in one route; the WebSocket manager receives it by injection rather than importing adapters, matching how it already receives `hookEventReceiver`.
4. **Signal vs authority** — Display data only; no authority. Compliant (`docs/signal-vs-authority.md`).
5. **Interactions** — `GET /sessions` output is byte-for-byte the same shape and values (same order: Telegram, then Slack, then headless). The WebSocket rows gain three optional fields; the dashboard already reads them for remote rows. A throwing adapter is caught per row and leaves `platform` unset, the previous behaviour.
6. **External surfaces** — The dashboard shows ✈️ instead of 🖥️ for this machine's Telegram sessions, plus tooltips and a "?" legend. The WebSocket message gains optional fields; no client relies on their absence.
## 6b. Operator-surface quality

1. **Leads with its primary action** — The session list is unchanged in order; the + (new session) stays the header's primary button. The "?" is a small secondary button beside it and the legend is hidden until tapped.
2. **No raw internals as primary content** — The legend and tooltips are plain sentences ("Linked to a Telegram topic", "No messaging app attached"). The model tooltip shows the model id the badge already exposed as a tooltip before.
3. **Destructive actions de-emphasized** — No destructive action added; the close (×) button is untouched.
4. **Plain language at phone width** — The legend is a tap-to-open block of one-line rows that wrap at phone width; tooltips are secondary (hover is absent on a phone, which is why the legend exists).

7. **Multi-machine posture** — Proxied-on-read already: remote rows come from each peer's own `GET /sessions` via the pool fan-out. Local rows are machine-local by design (each machine's WebSocket lists its own sessions). Both now use the same derivation, so a topic reads the same from every machine.
8. **Rollback cost** — Revert the commit and release. No state, config or migration involved.

Second pass: not required (no messaging, lifecycle, gate or sentinel surface).
