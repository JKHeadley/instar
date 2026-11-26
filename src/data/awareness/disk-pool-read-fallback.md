---
title: Disk Readings Across Machines
---
Use `GET /disk-steward?scope=pool` for measured disk space across the pool. Both that read and the scheduled disk watcher try another registered, credential-approved connection when the first connection fails. A peer error still means its disk was not measured; do not treat an unavailable reading as free space. Cleanup requests are never automatically repeated over another connection.
