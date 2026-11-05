# Lease job coverage and explicit catch-up

## What Changed

Each machine now keeps a bounded, signed observation of peers' scheduled-job catalogs. The lease holder compares those observations with its own jobs, repairs missing shipped defaults without changing existing jobs, and alerts when coverage is missing or uncertain. Promotion catch-up decisions are durable and default to asking before an overdue job runs.

## What to Tell Your User

After a lease move, Instar checks whether the new holder has the jobs it needs and alerts you about gaps. Overdue jobs on a promotion require your review unless a safe explicit policy applies. Git-sync stays disabled by default; job definitions and dependencies that exist only on another machine need manual restoration.

## Summary of New Capabilities

- Signed, metadata-only peer catalog observations remain available when a peer goes offline.
- Pool job listings show coverage status, source, age, and reason.
- Missing built-in jobs are restored without enabling git-sync or replacing custom settings.
- Coverage and catch-up alerts retry after delivery failure and remind while unresolved.
- Promotion catch-up decisions survive restart and use live lease authority before launch.
