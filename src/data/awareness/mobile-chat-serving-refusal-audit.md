---
title: App Chat Serving Refusals
---

When an app send reports that messages are not being received, inspect server warning logs for `mobile-chat-not-serving`. Each record has server time, PID, a fixed observed lease verdict, renewal age and TTL. The sample is taken after the existing refusal and is labeled `after-refusal`; `holding` in that sample must not be rewritten as an expired lease. Null or unavailable means the diagnostic could not be obtained. A prior lead label does not prove the request-time lease was valid. Preserve the fence and uncertainty rules; these records contain no message or device data and authorize no resend or restart.
