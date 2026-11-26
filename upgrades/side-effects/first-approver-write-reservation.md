# Durable local reservation for first-approver writes

Phone enrollment and local device key replacement use the same local reservation key. The first stored operation excludes competing or changed intents, including after reopening the database. The registry replacement checks the exact intent, current holder, and reservation while holding the SQLite writer transaction. A failed or ambiguous effect leaves the existing reservation available for explicit recovery.

This checkpoint is disabled. It does not establish exclusive registry custody across processes or hosts, remove legacy writers, or finish the phone's acceptance journal transaction. Those production conditions are still required.
