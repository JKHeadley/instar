---
title: Ask-links escalation trial
requires: telegram
---
The draft review trial is available only when `toneGate.askLinksEscalation.enabled` is true. It uses confirmed findings after a reply is sent.

- Send a confirmed finding to `POST /rule-responses/finding` with `rule: "ask-links"`, the numeric `topic` and `message` IDs, and `confirmed: true`. The reply must already be recorded as delivered from the agent.
- Check an operator ask through `POST /rule-responses/draft` with the same rule and topic, the `draft` text, and `hasAsk: true`. The third distinct confirmed finding activates the draft check for that rule.
- If an exception is warranted, send the same draft and an explanatory `reason` to `POST /rule-responses/override`. An override belongs to that exact draft. These routes need the usual authorization and `X-Instar-Request: 1`.
