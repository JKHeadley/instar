# Dark Lifeline restart reserve

The dark runtime option partitions the per-account window into nine Lifeline starts and one server start. Local reserve grants have the same independent lease and expiry checks. Only ENOENT or ECONNREFUSED on reserve permits local fallback. Explicit refusal, malformed response, timeout and an already-issued IPC grant do not fall back. The existing bounded recovery episode replays the durable original operation and its network claim.

Both roles must begin and remain on compatible partitions, including replacements and rollback. Production startup does not supply the option. A standalone test runtime exercises a real IPC listener close and replacement with the original operation. No live restart, configuration or traffic change.
