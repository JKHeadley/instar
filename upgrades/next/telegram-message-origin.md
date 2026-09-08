# Telegram message origin

<!-- bump: minor -->

## What Changed

Telegram messages now retain a durable record of the originating agent, machine,
harness and model evidence. The visible footer defaults on; hiding all or part of
it does not disable recording. Bot messages, managed browser sends, attachments,
edits, automation and retained retries use the recorded delivery boundary.

If durable recording or execution custody is unavailable, the message is held.
A separately recorded fixed notice can be attempted once at the configured
operator alert hub, subject to current permission and credential ownership.
Uncertain acceptance never authorizes a blind retry. Fixed system notices identify
their producer and have no model; unavailable author observations remain unknown.

An active Telegram origin writer enrolls the existing bounded current-holder lease
renewal when its setting is omitted. Explicit renewal settings remain authoritative;
expired, superseded or unconfirmed ownership still prevents sending.

## What to Tell Your User

You can see which machine and session environment sent a Telegram message. The
information remains available for audit even when you hide the footer. If Instar
cannot safely record it, delivery pauses instead of sending an unauditable reply.
The fixed outage notice says: "Messages are being held because their origin could
not be safely recorded. Delivery is paused while recording is unavailable."

## Summary of New Capabilities

- Phone-friendly Message origins dashboard tab: audit history, agent defaults and
  conversation overrides, using the existing dashboard PIN. Display-only changes
  preserve model settings and never disable origin recording.
- Separate source and detector health, with bounded disposable config checks and
  an isolated Codex native-format canary. A local test provider verifies record
  parsing, not real-provider execution; unsupported harnesses remain explicit.
  Automatic checks wait 60 seconds after startup or restart, then recur after
  completion; pending diagnostic health during that first minute is expected.
- Authenticated origin history and delivery status, with explicit missing-peer coverage.
- Typed managed-browser sending that retains the agent-authorship signature.
- Existing-agent script, configuration and instruction migration.
- Explicit release certification based on reviewed sender coverage, producer bindings,
  final package bytes and development trials; ordinary builds do not certify rollout.

## Evidence

Focused unit, authenticated HTTP and production-lifecycle tests cover recording,
identity, display, custody, restart recovery, notices and lease ownership. Actual
local development trials cover visible and hidden text, attachments, signed browser
sending, native Codex guard observation and installed shell relay behavior.

Final full-suite status and remaining rollout limits are recorded in
`docs/specs/reports/telegram-message-origin-conformance.md` and its linked evidence
index. Physical cross-machine delivery and a signed complete release certificate
remain prerequisites to claiming complete fleet coverage; no such claim is made
by this release-note fragment.
