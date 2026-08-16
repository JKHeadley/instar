# Skip Ledger

Track computational work to avoid repeating expensive operations. When a job or session processes items (files, messages, records), log what was processed so the next run can skip already-handled items.

## Endpoints

- **View ledger**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/skip-ledger`
- **View workloads**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/skip-ledger/workloads`
- **Register work**: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/skip-ledger/workload -H 'Content-Type: application/json' -d '{"workloadId":"job-name","itemId":"unique-item","metadata":{}}'`

## When to Use

Any job that processes a list of items (emails, feedback entries, messages) should check the skip ledger first to avoid re-processing.
