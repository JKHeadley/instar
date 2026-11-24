---
title: A Truthful Working Signal In Each Conversation
slug: conversation-working-signal
author: echo
status: draft
approved: false
tier: 2
card: wc_00dd69504281f23d
eli16-overview: docs/specs/conversation-working-signal.eli16.md
---

# A Truthful Working Signal In Each Conversation

## User Outcome

The person reading a chat can see when fresh evidence says the agent is processing a turn there. A running session alone never means that a reply is in progress. This is a presentation signal, not a promise about completion time, a message-delivery receipt or authority to stop/restart/spawn a session. The agent event/read contract comes first, with a web renderer and a contract other installed apps can consume.

The parity project tracks this work in card wc_00dd69504281f23d. The design follows the Instar standards Verify the State, Not Its Symbol and Framework-Agnostic and Framework-Optimizing. Conversation status has a framework-independent shape and uses each provider’s strongest verified turn source. The first implementation supplies one Codex source. This feature is separate from encrypted pending sends and from received-history browser caching, whose explicit privacy choice remains cardwc_d811087189ecc048. It must not change either storage policy.

## Grounded Existing Surfaces

- HookEventReceiver stores accepted projected hook events before emitting them. Its incarnation index distinguishes a current Instar session from a prior process reusing the same tmux name. Existing summaries count events and record times; they do not define a current turn state.
- NativeHookEvents projects onto a bounded schema and never stores the raw prompt or tool-output body. Its allowlist currently excludes UserPromptSubmit.
- The Claude reporter templates currently include PostToolUse and Stop, but not UserPromptSubmit. New-agent and existing-agent reconciliation must agree before claiming start evidence.
- installCodexHooks includes UserPromptSubmit and PostToolUse reporting but its Stop group currently contains gates rather than the observability reporter. These gaps matter for any future hook-based source. The ordered source in this draft requires no hook changes.
- AgentActivityState is global inbound/spawn evidence for sleep decisions. It is unsuitable for a per-conversation reply indicator.
- frameworkActivitySignals contains scrollback-persistent tool/event markers for watchdog purposes. It must not become the authority for current reply progress.
- Unsupported framework evidence is unknown. Gemini support cannot be inferred from the abstract adapter interface; its declared capabilities and installed hook path must be checked separately.

## Contract Floors

1. Scope every observation to the current serving machine, conversation and running Instar incarnation. Framework session IDs and helper IDs cannot substitute for that tuple. A stopped or replaced incarnation cannot update its successor.
2. Consume only bounded projected metadata. Do not expose tools, prompts, transcript paths, identifiers or message text to a status reader merely because the agent emitted an event.
3. Observe main-agent events separately from helper events. SubagentStart, SubagentStop and TaskCompleted cannot independently start or end the main turn.
4. A missing event, server restart, unsupported framework, stale observation, ambiguous order or dark holder produces unknown. None proves that the agent finished or that the conversation has no active session.
5. Route reads through the existing conversation read authority and holder rules. Revocation, inaccessible App rows and remote-holder darkness must not leak another conversation's activity. Do not infer remote idle from local absence.
6. An activity observation can change presentation only. It cannot authorize send, cancel, stop, swap, retry or automatic recovery.
7. No per-conversation timer is needed merely to expire a display observation: compute freshness at read time and client render time. Bound retained state and dispose listeners on server shutdown.
8. The web indicator must preserve the composer, selected files, scrolling, delivery labels and connection line. Updating describes history catch-up; working describes agent evidence. They are independent.
9. Status responses and browser memory must not create a new received-history disk cache. No service worker or background push claim.
10. Old clients ignore additive versioned evidence. Old servers provide unknown rather than a false negative.

## Launch-Owned Turn Evidence

Use a local, launch-owned Codex app-server connection for the first supported deployment. The existing TUI embeds its backend and has no passive event output. Codex 0.171.0 accepts a private Unix socket endpoint with the real TUI in remote mode. A disposable TUI and attached app-server completed an actual fixture turn through a relay. The relay observed matching `turn/started` and `turn/completed` events and correlated them to the TUI’s `turn/start` request and successful response. A second connection that only initialized received no thread notifications, so it cannot serve as a passive observer.

An app-server child and relay are owned by one exact managed Instar incarnation. Register the conversation binding before accepting events and require the selected native thread from the TUI’s successful `thread/start` or `thread/resume` result. Correlate a positive observation with the thread and native turn ID from a TUI request and the provider event pair. If the native start arrives before the RPC response, retain only bounded identifying metadata until the response confirms it; a completion observed meanwhile clears it without showing a transient positive. Multiple turns, auxiliary threads and provider work that is unrelated to that request cannot light the conversation. Resuming a conversation begins unknown. A reconnect, failed request, closed transport, replaced thread, lost event order or mismatched completion clears evidence. Positive status ages from the accepted start evidence and never refreshes from message text, tool events or an unchanged connection.

The saved rollout remains an independent source for existing delivery and model attribution. Its thread ID, pathname and descriptor do not establish which process wrote an event. The workspace probe showed that the current Codex process may open multiple rollouts and that a second writer can open the same file. Filesystem snapshots cannot prove who wrote intervening bytes. The working indicator never consumes the rollout or changes delivery observer scheduling, storage or retries.

## Managed Launch and Containment

First validate the launch path in a disposable sandbox with the repository’s loopback provider. Production support requires an explicit capability for a verified Codex version, platform, and direct local owner read. The feature starts dark. Ordinary embedded launches and unsupported or unproven sessions retain their existing launch and produce no positive evidence. The dark path cannot affect which account, model, environment, rollout or working directory ordinary launches use.

Use only local Unix endpoints under a private per-incarnation directory. Codex can create a symlink from the requested path to its own ephemeral socket. Validate the real socket, its owner, private parent and association with the launched child. Do not expose a TCP listener. The relay accepts one managed frontend and pairs it with the app-server for that incarnation. Verify local peer identity where the platform provides it. Missing ownership proof or connection ambiguity disables observation. Existing requests, responses, notifications and approval messages are passed through transparently and in order. The relay keeps no message bodies, files, credentials or prompts in status state or logs. Bound concurrent launches, buffered bytes, outstanding requests and observation state. Use transport backpressure and a bounded byte queue. Inspect only a bounded prefix or complete message within the observation budget. Forward transport bytes unchanged as they become available and pause upstream when the downstream transport is saturated. Do not wait for complete inspection before forwarding. A slow receiver and an oversized frame exercise the bound without a stalled or dropped conversation. If observation skips an unclassifiable frame, clear pending and positive evidence immediately because the frame could contain completion. Forward that frame intact to the TUI. A subsequent fully correlated start is required before showing working again.

Before enabling the managed launch, exercise account placement, startup and resume, one-time approval behavior, interruption, stop and reaping, and protection against two clients entering the relay. Before enabling the path, run the same deterministic blocking Stop hook through embedded and managed launches, including resume. Verify one invocation per attempted stop and the same decision effect for both launch variants. Keep the capability dark if that check differs. A failed probe or startup yields unknown. A failed or disconnected live launch follows existing recovery ownership and cannot automatically replay a submitted message or create a second writer. End of the managed incarnation closes its child and relay; stopping observation alone does not stop the conversation.

## Chat Reads and Rendering

Carry optional status on the existing latest-chat responses for a currently authorized signed owner device, including a signed owner browser device. A team reader may enter a chat while being barred from specific messages. Since raw turn evidence cannot identify which visible message triggered it, omit status for team devices, unaffiliated Bearer callers and all other principals. The web scheduler already polls App events, Telegram topic messages and Slack messages; scheduled App history fallback also needs the field. Older-page responses cannot update the current indicator. A successful latest response without the field clears prior positive evidence. An empty delta still carries status, independently of how message hashes or cursors are handled. When the latest response comes from an unverified holder, omit the positive status. Reuse each route’s existing remote caller eligibility and post-await ownership check, including Slack’s signed current-owner handset restriction. A pool page can merge history, but only the verified current holder supplies working evidence. A historical copy or a secondary holder cannot supply it. App’s local events route must verify a live authorized conversation before including status. The existing App and Telegram history fan-outs cannot elect the holder from the rows they merge. If a current ownership check and targeted authorized read are unavailable, omit status for that pool result.

A positive response includes `working: { v: 1, freshForMs: 6000 }` alongside the existing response fields. `freshForMs` is a positive integer in milliseconds and is capped at 10,000. A clearing App delta can be `{ events: [], cursor: "next" }`. Omit `working` for clearing, unavailable evidence, or a legacy server. Reject invalid versions and lifetimes as missing evidence. Compute remaining freshness at the serving holder and bound it again on receipt. Do not persist it, attach it to message rows or carry it across conversation selection. The web client compares the current conversation view, local serving selection and poll leader generation with the snapshots captured at request start. A selection change clears the indicator before the next poll. Version one omits positives on proxied and pool responses. A future remote path requires that the client request carry an already known, authenticated holder binding and that the server independently reconfirm that binding when returning the response. A display machine name, a merged history row and the working object cannot establish a generation. Where the existing client route supplies no authenticated holder binding, render working only from the positively verified local serving route. Apply status only from scheduled latest reads. Within each holder and leader generation the existing single-in-flight scheduler starts the next status-bearing read after the prior result has settled, so server sample order is consistent with request order. Initial, direct manual and older-page history can update messages but cannot update status. A newer scheduled response without working advances the same ordering fence as a positive response. Discard an older result even if its original deadline is still in the future. When a current Web Locks leader can be identified, broadcast status only for that leader and use a monotonic coordinate shared across tabs. Reject broadcasts from any former leader. On an observed leader generation change, synchronously clear an already accepted positive while the new leader first polls. If the browser cannot reliably identify generation changes, use same-tab scheduled responses only. Without leadership proof, each tab can use its own accepted route response, while history broadcasts carry no status. The receiving tab caps validity from the original request start. Never recompute a deadline from a broadcast’s receipt time. Use the existing visible-chat render and expiry scheduling rather than introducing a second polling loop. A failed poll does not extend validity. Use no-store caching for status. Discard malformed status independently of message content. Clear the indicator on authorization loss, holder changes, and expiration without a new response. On pageshow and return to visibility, validate the current view, holder, leader generation and original monotonic deadline before restoring or displaying cached UI. A paused callback cannot keep a positive alive. Announce “Agent is working” accessibly on a transition to a fresh positive state, without repeated announcements on each poll or a completion announcement when evidence disappears. No new pairing prompt is needed. Very short turns can finish between polls. An extended turn can lose its indicator once its opening observation expires. Measure visible delay and these loss cases through the browser. The first acceptance target is one ordinary unpaused visible chat on the local serving computer. Test turns lasting at least two normal latest poll intervals, with starts distributed across poll phases, including a turn starting during an outstanding latest read. The nominated supported run has at most one visible scheduled chat, a newest poll interval at most 5,000 ms, and completed latest reads within 1,000 ms of request start. Record observed intervals and missed as well as visible turns. Do not claim a broader workload until measured. Each must show working before completion under that supported workload; also confirm it clears by the original expiry when evidence stops. Publish measured event-to-render latency before claiming coverage under greater concurrency.

## Migration Parity

The initial launch-owned design requires no hook template or reported-payload changes. If a later framework path depends on a built-in hook change, reconcile it through both initialization and update, preserve custom hooks and stop gates, and prove repeated reconciliation is idempotent. Adding generic start and stop reporting alone does not satisfy the ordering contract.

## Test And Acceptance Plan

Unit tests cover current versus old incarnation, helper isolation, start/progress/completion/abort, delayed and duplicate events, unsupported sources, expiry and restart unknown. Include native notification before the RPC response, concurrent auxiliary turns, replaced generation, ambiguous ordering, transparent approval forwarding, transport loss and an unclassifiable completion forwarded to the TUI without leaving a positive observation. A turn completed before the start is confirmed cannot transiently show working. Test realistic raw projections and do not fabricate turn identifiers absent from the installed adapter.

Signed HTTP integration uses real enrollment and conversation readers, ordered launch-owned observation, current-holder resolution and revocation. Assert no content leakage, wrong-conversation refusal, dark-holder unknown and a different local conversation remaining unchanged.

Production-lifecycle E2E constructs and starts the actual component through AgentServer/server initialization. Launch a real supported Codex TUI with its local app-server and the isolated loopback provider, then read through the production route with a real browser. Exercise native resume, startup refusal, an unrelated thread, cancellation, and existing approval/stop behavior on the verified launch path. Submit a message through the ordinary App or Telegram composer and trace the existing injection path into the TUI, the selected thread’s correlated turn, and the indicator in the originating chat. Cover terminal-origin submission independently. Verify appearance and clearing without a new message, unknown fallback, preserved newer draft/files and readable phone layout. Exercise quick conversation switches, a late positive result arriving after a newer clear for the same conversation and holder, and a direct manual history sample overlapping a scheduled status read, a late result from holder A arriving before the first poll for the new holder B completes, out-of-order results across tabs, authorization loss, reconnect and expiry without another network response. Test authorized direct local reads, pool and proxied reads omitting status, a dark holder and revocation while a request is in flight. Include an owner browser, a team device that can read the chat but not the triggering message, an unaffiliated Bearer, an old leader broadcast after handoff, an already displayed positive during a visible-tab handoff before the new poll, a suspended tab resuming after expiry and leader change, and a browser without Web Locks. A null dependency or a no-op event subscription is a failure, even if a stub route returns200.

Independent source review follows the build skill. Full verification belongs to throughput. Chief publishes the exact committed head. A local commit is not a release or live owner acceptance.

## Frontloaded Decisions

- The first release targets managed Codex sessions running the positively verified launch-owned path and uses the existing chat refresh. The web client shows a positive indicator only. Eligible app clients may adopt the same additive field later.
- Use the existing conversation access rules. Pool routes lacking an independent current-holder check omit the status.
- Treat launches outside the verified path, unsupported providers and transport loss as unknown. On reconnect wait for a fresh native turn on the current proven connection.
- Bound event observation and keep it out of the request path. Browser reads only check a current in-memory observation. Exhausted observation budgets yield unknown.

## Open questions

*(none)*

## Decision points touched

The 10,000 ms compatibility ceiling is a conservative display default covering two ordinary 5,000 ms latest polls. It keeps a disconnected view from presenting an observation indefinitely. It has no operational authority. The evidence observer must supply a shorter lifetime when the turn evidence is older. Adjust the default only after measuring working visibility and stale clearing in the normal browser path.

| Decision | Classification and basis |
|---|---|
| Conversation and incarnation identity | invariant; basis: irreversible-consequence; evidence: an incorrect join discloses another conversation’s activity across an existing read boundary |
| Main and helper distinction | invariant; basis: enumerable-domain; evidence: only events correlated with the selected main thread and its confirmed turn can establish a main turn, so helper records are outside the source domain |
| Freshness expiry | invariant; basis: external-constraint; evidence: the browser must enforce the server evidence’s advertised lifetime, including while no requests complete |
| Missing, unsupported or dark evidence | invariant; basis: enumerable-domain; evidence: knowledge of current working state requires accepted start evidence, which these cases do not provide |
| Turn ordering | invariant; basis: external-constraint; evidence: the launch-owned stream supplies request order, thread ID and turn ID, while independently delivered hooks can arrive out of order |
| History and status independence | invariant; basis: external-constraint; evidence: latest polling can return zero messages while evidence changes, and older-page requests can complete after a conversation switch |

## Multi-Machine Posture

Version one serves ephemeral evidence only through a verified direct read from the current local serving computer. A pool or proxied history response continues to return its usual messages and omits working. A future remote read must route to a verified holder and carry existing authorization across the hop. A server restart clears evidence. The feature adds no notices, shared URLs or replicated prompt data.

## Rollback

Disable the opt-in launch for new sessions and detach the UI read model. Existing remote-backed test sessions drain through their existing lifecycle before launch resources are removed. Reverting must preserve existing hook behavior and every operational gate. No new durable message schema or encrypted-store migration is needed. An older renderer ignores the extra evidence. Reverting observability must not remove the stop-gate router, response review or custom hooks.

## Review status

The design reached the six-round limit without approval. The final review requires an ordinary composer-to-TUI-to-indicator trace, a production-suitable backpressure proof using an oversized frame and a slow receiver, and a real browser timing measurement during an outstanding read. The isolated native turn probe establishes the event source and leaves those integration requirements open.
