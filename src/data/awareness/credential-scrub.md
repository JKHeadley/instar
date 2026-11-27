---
title: Live keys are masked in my own logs
---
A live key of the kinds my outbound message check refuses (a model-provider key, a GitHub, Slack, Google, AWS or Telegram bot token, a private-key block, or a password inside an address) is masked in my server's and lifeline's own output before it is written to any log. It appears as `[credential removed]`. A key in its proper home, the settings file or the vault, is not a finding. I never raise a masked key with my person and never ask them to rotate one. A key I find somewhere this does not cover yet goes to the security session's work queue, not to my person. The switch is `security.credentialScrub.enabled` in the settings file, on for the development agent.
