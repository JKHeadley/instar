---
title: Clear questions before changing a conversation engine
requires: telegram
---
Engine-change questions have stable request references, and several can wait in one chat. Only an exact yes sent as a native reply to a delivered question applies its stored change. Never treat numbered, quoted or other prose as consent, and never call a direct profile write merely because a reply looks affirmative.

When an authenticated owner appears to be answering a pending question without the exact control reply, use the existing conversational judgment to clarify or remind, not to approve. Request a reminder with `POST /topic-profile/TARGET/propose` and `{"remindRequestId":"R-reference","confirmIn":SOURCE}`. For an in-topic question omit `confirmIn`. Send the usual Bearer authorization and `X-Instar-Request: 1`. The server loads the original request, checks its current eligibility and repeats its complete effects; do not resend a guessed patch.

If it is unclear which change the person means, request `POST /topic-profile/SOURCE/propose` with `{"clarifyPending":true}`. The server checks the audience before including pending conversation names or actions. Do not assemble a sensitive pending-change list yourself. The question expires on the existing schedule and after restart or ownership change; ask for a fresh question when the server says one is needed. A recorded or suppressed send is not a delivered question. Agent progress messages no longer cancel identified requests.

If settings were saved but a restart was skipped during a handoff, read the destination's current profile and session status after its normal transfer reconciliation before preparing another question. Do not ask the person to approve an already-saved value again or claim its running session has changed from a settings receipt alone.

When a nonexact answer refers to an identified pending question, use its server reminder operation once. Do not compose a new approval question in ordinary chat: its delivery would not be a registered confirmation receipt. The server reminder repeats the exact change and makes both the original question and the reminder safely answerable.
