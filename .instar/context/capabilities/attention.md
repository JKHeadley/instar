# Attention Queue

Signal important items to the user. When something needs their attention — a decision, a review, an anomaly — queue it here instead of hoping they see a chat message.

## Endpoints

- **Queue an item**: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/attention -H 'Content-Type: application/json' -d '{"title":"...","body":"...","priority":"medium","source":"agent"}'`
- **View queue**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/attention`
- **Resolve**: `curl -X PATCH -H "Authorization: Bearer $AUTH" http://localhost:4042/attention/ATT-ID -H 'Content-Type: application/json' -d '{"status":"resolved","resolution":"Done"}'`

## Proactive Use

When you detect something the user should know about (stale relationships, failed jobs, CI failures, overdue actions) — don't just log it. Queue it. The attention system ensures it gets seen.
