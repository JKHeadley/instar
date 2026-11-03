# Lessons-aware review, Round 2: THREADLINE-PROMISED-REPLY-SPEC (DRAFT v3)

Read in full: the v3 spec (268 lines), round-1 lessons-aware.md and cross-model.md. Did not re-read source code this round; code claims below are carried from round 1 or are about spec text only. Spec not modified.

## Part A: round-1 findings against v3

| Finding | Settled? | v3 evidence |
|---|---|---|
| F1 capture point / session identity | Yes | Decisions 1-2 (L45-54) key on settle()==='sent', not text; listener liveness L147-148; non-deferred path L46-47 |
| F2 close ignores relay-rejected, no hook | Yes | Decision 3 (L55-68), single check at fire time, reuses hasCanonicalReplyFor |
| F3 reap recovery | Yes (see N5 for a residual) | L150-152, test 20 (L248) |
| F4 transport / trust / forgery | Mostly. Residual: capability source (L254-258) | Decisions 4-8 (L69-88), test 18 |
| F5 at-most-once | Yes on one machine (see N3 for cross-machine) | L155-158, interface L116/L118, test 14 |
| F6 receive paths | Yes | Section 5 (L175-186), Section 4 (L170-173), test 8 |
| F7 awareness / migration / supervision | Partly. Awareness and migration yes (L205-212, lessons-engaged L16). The P7 supervision declaration for the sweep is absent | see N4 |
| F8 brakes / burst | Yes | L139-141, L159-163, tests 16-17 |
| F9 ownership | Yes | Section 2 (L127-135), tests 11-12 |
| F10 test 5 vs restart-lost | Yes | test 6 (L234), L145-146 |
| F11 older-peer bound | Yes in intent | Decision 9 (L89-92); depends on N1 |
| F12 frontmatter | Mostly; no seven-dimension side-effects mapping | L16 |
| F13 unverified figure | Yes, attributed | L124-125, L259 |
| D1 trust/downgrade | Yes | Decisions 6-7 |
| D2 inputs into design | Yes | Decisions 4, 10; Sections 4, 7, 8 |
| D3 forwarded replies | Yes | L66-68 |
| D4 settle plumbing | Yes | Decisions 1-2 |
| D5 receive side effects, surface name | Yes | L184-186, L188-193 |
| D6 older-peer bound | Partly: gate chosen (decision 9), mechanism it depends on is an open question (L254-258) | N1 |
| P1-P4 precision | Yes (worked timeline L165-168) | |

Unsettled round-1 items: 2 (capability source for decision 9; sweep supervision declaration).

## Part B: new findings

### DESIGN

**N1. Decision 9 rests on a capability list that may not exist for the peers that matter, and nothing refreshes it (L89-92, L254-258).** Open question says relay-only peers may have an empty list, so "fail closed" means they never get a notice. Separately, nothing in Section 8's change list adds advertising of `reply-notice` on our side, so no peer can learn we support it either. The list is filled by health pings, so it can also go stale: a peer that downgrades (rollback case, L224-225) stays "capable" until the next ping and receives a notice it treats as content and routes to a session. State with no refresh trigger. Required: decide the source now (relay handshake vs fail closed), add advertise-side changes to Section 8, give the cached capability a TTL or invalidation on a downgrade signal.

**N2. The rollout forcing function only reports (L217-219).** "The peers-health surface reports `rollout: OVERDUE`" is a flag on a surface; nothing acts on it, and "the file records a reason to stay" lets the flag be silenced by writing a string. This is the Advisory-Only and Shadow-Mode-Without-Forcing-Function shape. Required: an actuator, e.g. a scheduled check that raises an attention-queue item or auto-disables dry-run after the deadline, with the reason-to-stay carrying its own new deadline.

**N3. At-most-once and obligation state across machines (L129-135, L155-158).** State transitions are appended entries in a replicated log, but the spec never says how the current state is derived from entries (last-writer? max state?) or how conflicting entries from two machines resolve. Failover case: holder A appends `sending` and sends, replication lags, holder B sees `open` and sends a second notice. The crash rule (L157) is local only. Required: a fold rule for the entries (state is monotone, `sending` beats `open`), and either a pre-send replication check or a stated bound that failover within the replication lag can double-notice, with a test.

**N4. Sweep has no supervision and its in-memory index has no refresh path (L139-141).** The index is "loaded at boot and updated on append." Entries arriving by replication after a failover, or written by a path that bypasses the append funnel, are not in it, and failover is not a boot. Also nothing detects a wedged sweep (a live process whose sweep stopped firing): no notices go out and no signal appears, the exact failure the sweep exists to prevent. Required: reload or reconcile the index against the logs on a slow interval and on holder change; a sweep heartbeat surfaced and acted on; the P7 supervision tier declared.

**N5. Tests that can pass without testing what they name (L227-250).** Many tests assert an absence ("closed, no notice" 1, 2, 7, 11, 13 for `answered-elsewhere`, 19, 20, 21, and the no-replication half of 12). With the feature disabled, the clock never advanced, or the sweep not running, they pass. None states a positive control (the same fixture without the closing event does produce a notice) or that time advanced past T and the sweep evaluated the obligation. Test 18's "not refused as a downgrade" cannot fail on a pinned peer because the notice is encrypted and the downgrade check is never reached; it needs an assertion that the downgrade function was not consulted or a plaintext fallback case. Test 16 says "bounded" with no number. Test 22 should assert the would-be notice content, not only that nothing was sent. Required: add the control and the time-advance assertion to each negative test, a number to test 16.

**N6. The dry-run flip criterion has no evaluator and does not measure what it names (L220-221, L42-43).** "Every would-be notice matches a real stall and none fired on a thread that got a reply" is judged by whom? The check could be passed by someone eyeballing logs. It also only measures false positives; missed stalls (the gap itself) are never counted. And dry-run sends nothing, so the encrypted send, the receiver validation and the capability path are never exercised, yet the wire format is declared final (L42-43). Required: a script that computes the criterion from the logs and writes the verdict into the rollout file, a missed-stall count, and a loopback test of the real send/receive path between two test agents.

### MINOR

- **N7.** Reap-recovery hold (L150-152) leaves the obligation open with no bound; if the recovery entry is stuck, the obligation runs to the 24h ceiling and expires silent. Same for decision 11 (L96-98). Add an `expired` count and reason to the sender view (L190-191) so silent expiry is at least visible, and cap how long a recovery entry can suppress.
- **N8.** Receiver accepts 10 notices per peer per 24h (L87-88) while the sender cap allows 24 per day; later notices are silently dropped. Align the numbers or state it. Also the "within last 24h and not in future" check (L86) will reject legitimate notices under modest clock skew or an ackedAt at exactly the ceiling; add tolerance.
- **N9.** Decision 3's second rule (L58-60) would count any outbound non-ack, non-notice, so a progress message of the HONEST-PROGRESS kind closes the obligation and a later stall is never noticed. Name which kinds count.
- **N10.** `operator: true` and the "bound to sessionName" check (L198-200) run over an agent-wide server token, so the caller's session is a self-claim and the flag is self-set. Effect is limited to the agent's own sessions, but the bound is advisory; say so or authenticate the session.
- **N11.** Config `mode` has only `dry-run` named (L212); name the live value. No seven-dimension side-effects mapping (F12 remains partly open).

## Summary

Unsettled round-1 findings: 2. New DESIGN findings: 6 (N1-N6). New MINOR: 5.

Verdict: NOT CONVERGED.
