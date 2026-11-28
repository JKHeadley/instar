---
title: Telegram send timing observations
requires: telegram
---
Text sends write `[telegram-send-timing]` start and headers/error records to the sending process's logs. Match the PID and request id to compare elapsed network time, event-loop delay samples and overlapping process utilization. A headers record is not a delivery receipt. Missing histogram samples mean unavailable, and utilization does not identify which feature caused a pause. These records omit message content, destinations, URLs, credentials and error text. They do not authorize a resend or change the existing outcome checks.
