# Telegram

Full Telegram integration when configured.

## Endpoints

- **Search messages**: `curl -H "Authorization: Bearer $AUTH" "http://localhost:4042/telegram/search?q=QUERY"`
- **Topic messages**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/telegram/topics/TOPIC_ID/messages`
- **List topics**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/telegram/topics`
- **Create topic**: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/telegram/topics -H 'Content-Type: application/json' -d '{"name":"Project Name"}'`
- **Reply to topic**: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/telegram/reply/TOPIC_ID -H 'Content-Type: application/json' -d '{"text":"message"}'`
- **Log stats**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/telegram/log-stats`

## Proactive Topic Creation

When a new project or workstream is discussed, proactively create a dedicated Telegram topic for it rather than continuing in the general topic. Organization keeps conversations findable.
