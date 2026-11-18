# Round 2 — scalability DESIGN 3; externals codex 4 DESIGN, clean-door 3 DESIGN
Planned resolutions:
- Agent identity: use the agent-wide canonical identity key (one identity across machines) for handshake challenge, command frames, address/origin-list updates and revocations delivered to the PC; key rotation = signed by old key over live socket (or re-pair).
- Generation authority = the PC (monotonic counter persisted in its state, incremented per connection, sent in signed upgrade); server accepts highest; PC accepts frames only for its own current generation.
- Order: scan -> PC collects sealed link -> PC Connect (redeem -> pending row) -> phone Face ID approves pending row (as Mac). Fix journey.
- Origins: pin a signed list of the agent's stable origins (each machine's named tunnel), refreshed by signed frames; PC tries them in order.
- Rollback: handshake endpoint stays mounted returning feature-off; on disable: refuse new work, cancel running, send feature-off frame, close.
- Updates: verify Authenticode publisher subject / Artifact Signing identity (not one cert); manifest detached CMS with same identity rule.
- Inline results > 64 KB return via the stream relay; mesh RPC small frames only.
- Holder row replicated only on generation change; liveness held by holder; callers ask holder (cheap call) or use pool liveness.
- Audit: signed batches; repeated screenshot/input merged into counted rows; age-based retention with count backstop.
- Precision: 1 slot reserved for quick calls; audit page size/cursor; install copy step + HKCU Run stated; iOS only (Android out of scope, tracked); lineage note (Azure Arc/SSM); session-key encryption of frames optional (TLS already) — left behind.
# Round 2 — adversarial DESIGN 5; security DESIGN 4
- Scam (AnyDesk pattern): Connect screen scam warning ("if someone on a call asked you, Cancel"), forced 8 s wait, show agent OWNER's name (not just host), refuse Connect while a known remote-control app (AnyDesk/TeamViewer/QuickAssist/etc.) is running, "full use" NOT pre-ticked on first pairing? (tension with trivial setup) -> show both choices with neither pre-selected; abuse report path; residual risk stated.
- Files/input can raise switches: Files refuses Connect state + install folders + Run keys + Startup folders + scheduled task folder; switch state MAC'd with CNG key; input path refused while tray window/consent window is in front; raise needs owner phone presence confirmation; consent: file write ~= full control.
- Person vs agent: Stop holds until the person resumes; consent + remover say Stop/Remove are cooperative once Run commands is on; remover lists Run entries / scheduled tasks the agent created (from audit).
- Revoked PC via lagging machine: handshake accepted only after a revocation freshness check against the lease holder (or refuse retry-after).
- Generation assigned by the PC, signed in handshake.
- Session->person must be server-recorded (not X-Instar-Session-Id header) -> verify mechanism.
- Key rotation: old-key-signed hand-over frame; re-pair fallback; revocations signed by the pinned agent key.
- Precision: untrusted PC output; anti-downgrade; console shows PC-confirmed switch state; owner sessions incl. jobs with outside content = injection blast radius (consent sentence); team share grant issued only by owner phone, separate from conversation shares; manifest URL fixed to release host; push Lower immediately.
# Round 2 — decision-completeness DESIGN 11
- Session->person: use memory privacy's server-issued session token (SessionManager issueSessionToken(sessionId, audience, placeKey), src/core/SessionManager.ts:8491) with audience == PC owner only; single-person agent with privacy off (GET /team/people one person) -> agent bearer accepted; otherwise refused "turn on memory privacy". v1 owner-only (no PC share grant type).
- Done condition: live proof on Mama PC uses a LOCAL unsigned build (test-agent rung); signed public publish = separate gate (needs Justin's ID validation + Azure account/card: frontload in the approval ask).
- Stable address for new people: named tunnel needs Cloudflare account/domain -> spec states it as the existing requirement; ask (when it arises for a person) is one yes/no with link + cost; not blocking this run (Echo has one).
- iOS contract: write to .instar/vm-test/app-coordination.md + commitment; TestFlight/App Store build on Justin's phone checked via app version reported; on completion list.
- Overflow: inline cap is a path choice; overflow returns a stream ticket (no truncation unless the caller asked for a head).
- Stop holds until the person resumes. Breaker ends parked (only person Reconnect or signed address-moved wakes it); feature-off same parked state.
- Command duration: caller declares; default 2 min; floor = Stop + Job Object always work + tray indicator.
- Concurrency: holder arbiter on socket buffered amount + PC load; reserve one slot for quick calls.
- Audit: archive by age/size (Disk Steward arbiter), never delete.
- Precision: release gate pass/fail; 200-char reason (privacy); min app version filled at build; commitment id for wipe test; maturation standard alignment (cite registry ladder); redirect host repo (site/ Astro on Vercel).
