# Job Scheduler

Run tasks on a schedule. Jobs are defined in `.instar/jobs.json`.

## Endpoints

- **View jobs**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/jobs`
- **Trigger a job**: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/jobs/SLUG/trigger`
