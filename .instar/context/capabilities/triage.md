# Stall Triage

LLM-powered session recovery when configured. Automatically diagnoses and recovers stuck sessions.

## Endpoints

- **Status**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/triage/status`
- **History**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/triage/history`
- **Manual trigger**: `curl -X POST -H "Authorization: Bearer $AUTH" -H "Content-Type: application/json" -d '{"sessionName":"NAME","topicId":123}' http://localhost:4042/triage/trigger`
