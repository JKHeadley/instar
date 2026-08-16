# Feedback System

Report bugs, request features, suggest improvements. All via `POST /feedback`.

```bash
curl -X POST http://localhost:4042/feedback \
  -H "Authorization: Bearer $AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"type":"bug","title":"Short description","description":"Full details with context"}'
```

This routes feedback to the Instar maintainers automatically. Valid types: `bug`, `feature`, `improvement`, `question`, `hallucination`.

The feedback API stores a local receipt, forwards upstream, and tracks delivery.

## Endpoints

- **Submit feedback**: `POST /feedback` with `{"type":"...","title":"...","description":"..."}`
- **View submitted feedback**: `GET /feedback`
- **Retry failed forwards**: `POST /feedback/retry`
