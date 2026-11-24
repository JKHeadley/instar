---
title: Project round failure details
---
A project detail can show the framework, model, exit code or signal for its latest round attempt. A direct local read on the machine that ran it can also show the scrubbed error. Read the project before explaining why its round stopped.

```bash
curl -H "Authorization: Bearer $AUTH" "http://localhost:{{port}}/projects/PROJECT_ID?fields=rounds"
```
