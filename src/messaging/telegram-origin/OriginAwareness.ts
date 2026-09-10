export function telegramOriginDashboardAwareness(): string {
  return 'Message origins on your phone: open the dashboard, unlock with your PIN, then choose Message origins. Read recorded machine/harness/model evidence and delivery status, with incomplete pool coverage labeled. Open Display settings to change agent or conversation origin-detail checkboxes; Use agent defaults clears an override. Cosmetic choices apply to newly prepared messages and never disable recording. Conversation display choices are independent of model-profile rollout gates.\n';
}

export function telegramOriginDetectorAwareness(): string {
  return 'Origin detector health: `GET /telegram/origins/status` includes `detectorHealth`, separating fresh source observations, fixed-input canary checks, native hook proof and current-model evidence. Automatic owned and native canaries wait 60 seconds after every startup, then recur after completion (hourly by default); a restart restarts the wait, so pending health during that minute is expected. The owned checks use disposable state; `messageOrigin.detectorCanary.intervalMs` accepts 60000 through 604800000. Successful checks grant no send or ownership permission. Reads do not refresh evidence timestamps; pending, failed, stale and unavailable states remain explicit. Native canary support is reported per harness; a hook proof or regression fixture does not prove model extraction. These diagnostics do not copy live credentials, change operator settings or send Telegram messages.\n';
}

export function telegramOriginNoticeAwareness(): string {
  return "Outage notices default on for the configured operator alert hub only. Set the Telegram messaging config's `messageOrigin.outageNotice.enabled` to false to opt out without disabling origin recording. An independent configuration observer refreshes permission and hub binding; unknown or stale state suppresses the notice, and current credential ownership is checked before sending. Telegram applies each user's personal mute/archive settings; Instar does not claim to inspect them. A known missing topic or an unknown receipt never permits retrying the fixed notice.\n";
}

export function telegramOriginCertificationAwareness(): string {
  return "Origin rollout certification: the activation report checks current peer observations and a package-owned, signed build certificate for sender coverage, producer bindings and development trials. `origin-release-certification-not-installed:release-pipeline-issuance-required` means the release has not supplied that evidence. After reviewing its inventory and trials, the release pipeline explicitly runs `npm run release:certify-telegram-origin -- --package-root <final-package> --review <approved-review.json>` with the pinned Instar release authority; normal builds do not certify; the existing lock-file signature covers a different artifact. Preserve this incomplete status until genuine evidence is installed. A source search, package version or manually edited status cannot certify coverage. Aggregate readiness is diagnostic; each send still requires its own durable origin and current authorization.\n";
}

export function telegramOriginLeaseAwareness(): string {
  return 'Origin lease renewal dependency: an enabled Telegram origin writer enrolls the existing current-holder renewal timer so ordinary installations keep a confirmed lease beyond its TTL. Explicit `multiMachine.leaseSelfHeal.resilientRenew.enabled: false` remains an opt-out; lease expiry still holds sends. Observe-only roles, higher-epoch holders and failed partition confirmations remain fenced. Without an origin writer, the standalone renewal feature keeps its development-agent default. Never change identity records or bypass `holdsLease` to clear a delivery hold.\n';
}

export function telegramOriginRecoveryAwareness(): string {
  return 'Queued-message review pacing: automatic origin recovery reserves a durable 15-minute interval per original operation before reviewing or attempting delivery. Failed reviews, send refusals and process restarts cannot reset that interval. Existing origin audit records expose `recovery.attempts` and `recovery.nextAttemptAt`; these count recovery starts, not Telegram sends or tokens. A due retry still checks current policy. The original deadline and transport attempt limit remain in force, and retained messages are not guaranteed delivered. New replies are independent; never rewrite or resend a held message merely to bypass this interval.\n';
}

export function telegramOriginTransportAwareness(): string {
  return 'Telegram send deadlines: each network request gets its full timeout after origin review, recording and capacity preparation. A caller cancellation proven before network invocation leaves the original operation eligible for bounded recovery; it does not cancel durable message intent. Failure after network invocation remains uncertain and must not be replayed merely because it reports an abort or timeout. Slow review can still hold a message, and queued custody is not delivery confirmation.\n';
}

export function telegramOriginCapacityAwareness(): string {
  return 'Telegram capacity checks: ordinary replies acquire the credential owner\'s short-lived capacity only after durable dispatch intent, immediately before network invocation. Storage preparation cannot use up that grant. An unavailable or expired grant still holds the original message and consumes a charged attempt, even if no network call started; sustained capacity refusal can exhaust its original attempt limit. The existing recovery pacing, deadline, ownership and shared rate limit remain in force. Never recreate a held message to obtain a new budget.\n';
}

export function telegramOriginAwareness(port: number): string {
  return `
### Telegram message origin

Every enrolled Telegram writer records machine, harness and model evidence before sending. Display defaults on; set the Telegram messaging config's \`messageOrigin.display.enabled\` to false to hide the footer without disabling recording. The \`machine\`, \`harness\` and \`model\` display bits can also be changed independently. Unknown/configured model evidence is labeled honestly.

For a conversation override, use the existing authorized topic-profile flow with \`messageOriginDisplay: {"enabled": false}\`. Clear that field with null to inherit agent defaults. The profile follows topic transfers; changes affect newly prepared messages and require no session restart.

Use the shipped relay script: it carries the session's preparation credential automatically. Never copy another session's credential or invent origin metadata. A recording failure holds the original message; a previously recorded fixed notice may be sent once to the configured operator alert hub. A held or unknown result is not permission to resend.

${telegramOriginNoticeAwareness()}
${telegramOriginCertificationAwareness()}
${telegramOriginLeaseAwareness()}
${telegramOriginDashboardAwareness()}
${telegramOriginDetectorAwareness()}
${telegramOriginRecoveryAwareness()}
${telegramOriginTransportAwareness()}
${telegramOriginCapacityAwareness()}
Ordinary bot messages and fixed outage notices share the credential owner's bounded send capacity across server and Lifeline processes. A \`credential-capacity-unavailable\` result retains the original operation for recovery; never replace it with a new message. An unavailable or stale capacity owner holds sends. Recording-worker failure does not disable the independent notice queue or its current permission checks.

Claude and Codex tool hooks direct raw Telegram writes to the recorded relay or typed browser broker. Managed Telegram profiles belong to the broker; generic browser tools cannot use them. This cooperative hook is not an operating-system sandbox. Other enabled harnesses must prove equivalent enrollment before activation; a hook being installed is not proof of complete sender coverage.

An enrolled operator Telegram browser profile exposes only typed operations: \`GET /telegram/browser/PROFILE/snapshot\` and \`POST /telegram/browser/PROFILE/send\`. Include ordinary API authentication plus \`X-Instar-Origin-Session: $INSTAR_ORIGIN_TOKEN\`. Send body: \`{"text":"Message","destination":{"kind":"channel","id":"123","topicId":42}}\`; add \`messageId\` for an edit. The server resolves account-specific peer credentials. Never pass JavaScript, access hashes or claimed model names. A 503 means that profile is not enrolled; a 409 is an explicit hold. Browser messages keep the agent-authorship signature even when the origin footer is hidden.

Browser and cross-machine replies use the existing outbound content and tone authority, including its structured 422 advisory responses. Browser requests may carry only the four existing advisory-reaction metadata fields: \`toneAdvisoryAck\`, \`toneAdvisoryAckReason\`, \`toneAdvisoryDecisionRef\`, and \`toneAdvisoryComplied\`. A signature never exempts a message from policy. Missing send-policy wiring holds delivery; restart recovery checks the sealed original text against current policy before dispatch. Local stand-down ownership checks apply to browser sends and relay handoff too.

When building an internal automated sender, use \`postOriginAutomationReply\` with the registered producer and the author call's evidence. The server creates a short-lived credential bound to the whole request; HTTP metadata cannot choose identity. Explicit fixed templates have no model; an unbound LLM author is unknown. Media uses a reply-linked companion where required. Multipart uploads retain their bytes in the same durable outbox before dispatch (50 MiB per file, 64 MiB per operation, ten files); retries use the signed references and exact multipart digest. Skipped forwards retain confirmed destination IDs while the unresolved remainder stays held.

Registry first: "which machine/model sent this?" or "why is delivery held?" → \`GET /telegram/origins\` and \`GET /telegram/origins/status\`. These require an operator session obtained through the dashboard, in addition to ordinary API authentication:
\`curl -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $INSTAR_AGENT_ID" -H "X-Instar-Operator-Session: $OPERATOR_SESSION" http://localhost:${port}/telegram/origins/status\`
Status includes an activation matrix: every required obligation and enabled writer must have a fresh enrollment observation before it can report complete coverage. Missing, expired or conflicting observations keep activation incomplete. 503 means the origin service or requested scope is unavailable; it is not proof of active enforcement or complete pool coverage. New capabilities should use the prepared egress boundary, never attach a handwritten footer as a substitute for recording.

Add \`?scope=pool\` to origin lists, individual-origin lookups or status to inspect all enrolled machines. Pool metrics count source evidence once and preserve unavailable shards' last-known counts as stale; incomplete coverage is explicit. Audit records include durable read-only recovery diagnostics. Legacy queued rows keep unknown author evidence and their original deadlines/attempt counts; ambiguous earlier sends stay held. A failed browser canary gets one fresh-process retry, then a persisted 15-minute pause and one attention item per episode. Status exposes the recovery pause even after restart.

Setup completion uses the authenticated loopback endpoint \`POST /telegram/setup/greeting\` with \`{"agentName":"Echo","userName":"Justin","autonomy":"proactive"}\`. The server renders and records its fixed greeting for the configured Lifeline topic, then pins the confirmed message. It accepts no arbitrary text or destination. Setup clients use \`sendOriginSetupGreeting\` after the server is running.
`;
}

/** Refresh only the known shipped wording; preserve operator additions. */
export function refreshOriginCanaryStartupAwareness(content: string): string {
  return content.replace(/^Origin detector health:[^\r\n]*$/gm, paragraph =>
    paragraph.replace('The owned config/vault/hub checks run at startup and hourly by default in disposable state;', 'Automatic owned and native canaries wait 60 seconds after every startup, then recur after completion (hourly by default); a restart restarts the wait, so pending health during that minute is expected. The owned checks use disposable state;'));
}
