# Side effects of durable Local Verify waiting entries

The lease holder saves the PR head and base ref alongside the existing waiting data. The file format is backward compatible. An older row without revision information is checked against GitHub before automatic admission. Existing holds save the revision when they take custody of a waiter. Previous installers can read the extra fields but resume their historical idle-expiry policy if rolled back.

The existing bounded sweep checks waiting requests. When a queue slot is available and main is healthy, it makes an ordinary verification request. Drafts and changed revisions cannot trigger a stale automatic request. GitHub lookup failure leaves the waiter intact. Queue capacity, launch safety, verification results and merge rules remain under their existing owners.

The waiting list refuses new work when full instead of evicting existing requests. The response exposes whether the request was recorded. A failed persistence write also returns an unsaved response and restores any previous in-memory row. An operator release that cannot persist its saved demand remains pending. Roll back by reverting the commit. Before doing so, preserve any currently waiting PR numbers because the historical idle threshold will apply again.
