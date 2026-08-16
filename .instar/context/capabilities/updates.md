# Update Management

Check for and apply Instar updates. The AutoUpdater handles this automatically, but you can also check manually.

## Endpoints

- **Check for updates**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/updates`
- **Last update**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/updates/last`
- **Apply update**: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/updates/apply`
- **Rollback**: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/updates/rollback`
- **Auto-update status**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/updates/auto`
