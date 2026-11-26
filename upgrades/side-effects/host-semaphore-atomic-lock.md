# Host semaphore lock publication

A contender now writes the owner record to a private file and publishes it through a same-directory hard link. The link is exclusive, so it cannot overwrite an existing owner. The temporary name is removed after either outcome. An unreadable or malformed owner record is kept because an older process may still be writing it.

The shared primitive serves the spawn semaphore and test-runner semaphore. It reports held or an I/O error to their existing admission policies. Those policies retain authority over whether to wait or refuse. The change enforces a filesystem invariant and adds no competing-signals heuristic.

The spawn lane still reclaims locks with an identified dead PID. Its separate dead-owner unlink race and shared-filesystem ownership limitations remain outside this change. An invalid legacy lock may require operator cleanup once its ownership has been checked. A filesystem that cannot create hard links returns a typed I/O error.

The focused tests cover exclusivity, complete owner contents, temporary-name cleanup, malformed records, live and dead owners, and the restored concurrent spawn burst. Revert the change at a drained boundary if the filesystem cannot support exclusive link publication.

Independent review by semaphore_review concurred with the stamped publication fix. The reviewer found that an older spawn process can still unlink a replacement lock after seeing a missing path during contention. Drain old spawn contenders before relying on the new guarantee across the host.
