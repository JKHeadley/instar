# Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

- **Topic purpose awareness**: TopicSummarizer now extracts a `purpose` field alongside each summary — a one-line description of the topic's current focus. Sessions receive soft awareness ("Current focus: ...") so they know what the topic has been about without being constrained. Job sessions get stronger posting guidance via a `[TOPIC AWARENESS]` block to keep autonomous output contextually relevant.
- **Prompt Gate**: Interactive prompt detection in sessions with auto-approval for safe operations and Telegram relay for risky ones. Includes InputClassifier, AutoApprover, and CallbackRegistry.
- **Schema migration v4**: `topic_summaries` table gains a `purpose` column. Migration is automatic and non-breaking.

## What to Tell Your User

Sessions now understand what each topic is about. When a conversation drifts to a new subject, the purpose updates naturally on the next summary cycle. Job sessions are aware of where they're posting and will keep output relevant to the topic context. Interactive prompts in sessions can now be auto-approved or relayed to Telegram for review.

## Summary of New Capabilities

- Topic purpose extraction in TopicSummarizer (via LLM PURPOSE line parsing)
- Soft "Current focus" awareness in session bootstrap
- Job session topic awareness block in JobScheduler
- TopicMemory schema v4 with purpose column + migration
- Prompt Gate: InputDetector, InputClassifier, AutoApprover, CallbackRegistry
- POST /topic/summary API accepts optional `purpose` field
- GET /topic/context returns purpose in TopicContext
