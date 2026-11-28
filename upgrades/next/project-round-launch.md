<!-- bump: patch -->
## What Changed

A project round now uses the same framework and model as the conversation tied to its project, through the normal launcher's command and account choice. It no longer always tries Claude. When a round can't start, or its process stops before doing any work, the project records why: the framework, model, exit code or signal, and a credential-masked diagnostic kept on the machine that ran it.

## What to Tell Your User

When a project round fails, I can now tell you why instead of only that it failed. Rounds also follow the model you chose for the project's conversation.

## Summary of New Capabilities

The project detail's rounds field reports the latest attempt's framework, model and exit code or signal (GET /projects/PROJECT_ID?fields=rounds). A direct local read on the machine that ran the round also shows the scrubbed error. A Claude profile that needs an interactive subscription session is recorded as a limitation, never silently moved to another billing account.

## Evidence

Unit, integration and end-to-end tests drive local fake child processes through the same launcher and project read.
