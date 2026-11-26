# Convergence Report — Native session screen for the Instar iPhone app

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier review ran through the agent's codex CLI in rounds 3, 4, 5 and 6. Rounds 1 and 2 degraded with `error`: the reviewer module in the agent-home checkout resolved the model `gpt-5.5`, which this ChatGPT-account codex login refuses (`model_not_found`). Current main resolves `gpt-6-astra`, and every later round ran on it. The Anthropic clean-door reader (`claude-code`, recorded as `clean-door-anthropic-review`, not cross-model) also ran in rounds 3 to 6. Gemini was not signed in.

## ELI10 Overview

The iPhone app has a button that shows the program (the "session") answering a chat. Today that button opens the web dashboard in Safari, which asks for a PIN. This change lets the app show the session itself: its live text, refreshed every 1.5 seconds, and a box to type into. There is also a list of all the agent's sessions.

To do that, the server lets a paired phone use two more routes: "read this session's screen" and "type this text into it". Only the owner's phone can use them. Other people's phones, revoked phones and unsigned requests are refused before anything runs. The phone can only reach sessions the agent knows about on that machine, and it can only type plain text, so it cannot press keys like Ctrl-C. Every typed message is logged (without its text), and the same signed message can never be typed twice, even across a server restart.

The trade-off is a little more machinery on the server: a second-machine lookup to say where a session really runs, rate limits, a small replay file, and redaction of the agent's own password from the screen text. In exchange the owner gets the session on the phone with no browser and no PIN prompt. It gives the phone nothing the owner's PIN does not already give it.

## Original vs Converged

- **Typing.** At first, "type text" took any string. Review showed control characters (Esc, Ctrl-C) would act as keys. Now only plain text, newlines and tabs are accepted.
- **Replay.** At first the spec said the existing signature check stops replays. Review showed that check forgets everything when the server restarts, and input is the first phone route where doing something twice matters. A first fix (refuse requests signed before the restart) was broken by phone clocks that run fast. The final design writes each accepted request's digest to a small file before typing and keeps it 3 minutes.
- **Which session.** At first a name was looked up loosely. Now it is matched exactly (tmux name, then id, then name), ambiguity is refused, a request can be bound to a machine (so a remote list row never types into a same-named local session) and to the session's permanent id (so a session that ended and whose name was reused is never the target).
- **Server load.** At first, reading a pane used a blocking call; it now uses the non-blocking one. Looking up "which machine runs this?" was unbounded; it is now cached, shared and capped per phone. Typing is limited to 12 a minute per phone and 12 a minute across all phones, because the typing call blocks briefly, as the dashboard's does.
- **What the phone sees.** Screen text is shown as plain text (no links or formatting from the session), with escape codes and text-direction tricks removed, hidden in the app switcher. The agent's own token, PIN and private-view signatures are redacted.
- **Honesty of answers.** "Not running" is only said when every machine answered; otherwise the answer is "I could not check". A machine's name comes from this machine's own registry, never from the peer. "Sent" means accepted by the session's input path, not acted on. For Codex sessions it can mean queued.
- **Records.** Each typed message is logged by length, phone and session, never the text.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware; conformance gate (2 flags, folded in before the round) | 17 | 6 | control-char filter, Face ID before send, exact name resolution, async capture, miss cache, output rendering, local registry nicknames, input audit, no auto-retry, non-owner UX, feature test, mount gating, rollback wording |
| 2 | adversarial (Codex Stage B queueing) | 1 | 7 | Stage B accuracy: `ok` may mean queued; journal holds text |
| 3 | security lens (typed-text claim); codex (replay across restart, remote-row collision, >16 peers); clean door (replay) | 4 | 3 | process-start check, `machine` binding, unasked peers = unknown |
| 4 | internal (fast phone clock defeats the start check); codex (same; snapshot semantics); clean door (same) | 2 | 5 | durable replay record, snapshot semantics, negative cache 3 s, input 12/min |
| 5 | internal (posture reason wrong with multi-route off); codex (blocking input, incarnation binding); clean door (token in pane output, wrong-session naming, blocking input) | 5 | 6 | redaction, `sid` binding, machine-wide input window, no fan-out for self-bound misses, two-peer ambiguity, canonical digest |
| 6 (cap) | internal: none; codex: redaction completeness, first-open binding, 409 handling in polling; clean door: wrapped token, async input, fan-out simplification | 6 | 5 | first-open `sid`, 409 terminal in the app; the rest accepted below |

Standards-Conformance Gate: round 1 ran (93 standards, 2 flags: Verify the State; No Unbounded Loops, both folded in). Later rounds: not re-run (the body changes were review-driven; the round-1 report was handed to every lessons-aware pass).

Per-round internal reviewer model: the authoring session's model (claude-opus-5-5) for all subagents. Rounds 3 to 6 ran the six lenses as two or one combined reviewer agents.

## Proportion

Tier 2 (security-sensitive: new device access to session routes). Spec about 130 lines; server change about 330 lines in 3 files plus tests; app change separate. Rounds used: 6 of 6. ⚠ This reached the cap. The later rounds each found real security or correctness gaps (replay across restarts twice, credential exposure, wrong-session targeting), so the rounds were earned, but the process cost is high for one screen.

## Left behind

- **Accepted at cap, security-adjacent: redaction is exact-match.** A token split by a line wrap, escape codes or encoding can still reach the phone. Accepted because the route is owner-only and the owner's PIN unlock already returns the API token itself to the same phone; the phone can learn nothing through the pane the PIN does not already give it.
- **Accepted at cap: input blocks the event loop briefly.** `sendInput` is synchronous (as is the dashboard's WebSocket input, which has no limit). Bounded here by 12 a minute machine-wide. An async injection path is filed as instar feedback.
- **Accepted at cap: the "which machine" lookup could be client-side.** Kept because Justin asked for the plain reason when a session runs elsewhere, and the app's list row can be stale.
- ETag/304 for unchanged output (battery and data saving).
- Audit refusals as well as accepted inputs.
- PIN redaction can mark where a short PIN-like number appears.
- `capture-pane -J` (join wrapped lines) for device reads.
- Bearer `POST /sessions/:name/input` passes the raw name to tmux (pre-existing; filed as instar feedback).
- Line-number citations replaced with function names.

## Full Findings Catalog

Round 1 (internal six lenses):
- Security: control bytes act as keys (DESIGN, fixed: refused); phone presence weaker than PIN (DESIGN, fixed: app lock plus Face ID within 5 min before first send, output hidden when inactive); per-miss fan-out (DESIGN, fixed: cache, single-flight, per-device cap); funnel description (PRECISION); case of names (DESIGN, fixed); match field (PRECISION).
- Scalability: synchronous capture blocks event loop (DESIGN, fixed: `captureOutputAsync`); repeated fan-outs (DESIGN, fixed); bucket map cleanup (PRECISION, fixed).
- Adversarial: control characters (DESIGN, fixed); stolen unlocked phone (DESIGN, fixed as above); case and collision (DESIGN, fixed); Markdown/OSC/bidi in output (DESIGN, fixed); lying peer nickname (DESIGN, fixed); miss fan-out (DESIGN, fixed); no input audit (DESIGN, fixed); Bearer raw name claim (PRECISION).
- Integration: mount gating (DESIGN, fixed); rollback contradicts migration (DESIGN, fixed); posture key wording (PRECISION, fixed); old server remote rows (PRECISION, fixed).
- Decision-completeness: send retry undecided (DESIGN, fixed: never auto); non-owner experience (DESIGN, fixed); app rollback and minimum version (DESIGN, fixed: feature test); CLAUDE.md line not pinned, start time source, peer cap order (PRECISION, fixed).
- Lessons-aware: no input attribution (DESIGN, fixed); `sendInput` described wrongly (PRECISION, fixed); no live-proof plan (DESIGN, fixed: Verification section); Bearer raw name (DESIGN, inherited, filed as feedback); legacy phones count as owner (PRECISION, stated and tested); miss cost (DESIGN, fixed); `ok` wording (PRECISION, fixed).
- Codex and clean door: degraded (`error`, stale model resolution).

Round 2: Codex Stage B journals and may queue (DESIGN, fixed). Precision: posture/audit wording, shared miss cache, 2000-line cost, legacy role test, InputGuard decision point, feedback claim, AppLock dependency, peer match order (all folded in).

Round 3: "Text was typed in" claim wrong for queued Codex delivery (DESIGN, fixed). Codex: replay after restart (DESIGN, fixed), remote row resolving to a local session (DESIGN, fixed), more than 16 peers claims absence (DESIGN, fixed), typed-text claim (PRECISION). Clean door: replay (DESIGN, fixed), bucket relation to the 120/min cap (PRECISION, stated), ETag (left behind), fan-out simplification (left behind).

Round 4: fast phone clock defeats the start-time check (DESIGN, fixed with a durable replay record); snapshot semantics undefined (DESIGN, fixed); `machine` parameter as proof (PRECISION, fixed); negative cache for a just-started session (PRECISION, fixed); paste behaviour for multi-line (PRECISION, stated).

Round 5: posture reason wrong with multi-route off (DESIGN, fixed: true reason plus accepted residual); input blocks event loop (DESIGN, fixed: machine-wide window); no incarnation binding (DESIGN, fixed: `sid`); token in pane output (DESIGN, fixed: redaction); wrong-session naming on self-bound miss and two peers (DESIGN, fixed); digest keyed differently from the parent (PRECISION, fixed); WebSocket reason (PRECISION, fixed); fan-out bound wording (PRECISION, fixed).

Round 6: internal none (precision: busy flag redundant, removed; slot use on failure, stated). Codex: redaction completeness (accepted, see Left behind); first-open binding (fixed); 409 handling in polling (fixed). Clean door: wrapped token (accepted); async input (accepted, feedback); fan-out simplification (accepted); PIN redaction, refusal audit, ETag, digest-on-failure (left behind or stated).

## Convergence verdict

Stopped at the round cap (6). The final internal round found no design issue. The final external findings were either fixed in place (first-open binding, 409 handling) or accepted with reasons (redaction completeness, synchronous input, client-side lookup). The one security-adjacent item gives the owner's phone nothing beyond what the owner's PIN unlock already returns. Nine items are left behind. The spec is ready for approval.
