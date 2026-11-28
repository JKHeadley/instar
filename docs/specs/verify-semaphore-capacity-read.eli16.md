# Local Verify semaphore capacity reads

A busy test machine checks how many test slots it has free. That quick check used to reread a log kept to explain past decisions. This change lets the quick check use the current count alone. The diagnostic screen still has the history, and the same rules decide when a test can start.
