# Storage errors say which machine needs attention

When Justin sent a file from his phone, the Mac Studio refused it because its disk was almost full. The error said “this machine,” but the phone talks to one agent running across several machines. That left him unable to tell which computer needed space.

The same problem can happen beyond file uploads. A paste directory can reach its size limit, the program can fail to save its notification records, a database can fail to write, or the existing health check can find low free space. Each of those messages needs to identify the computer where the problem happened.

This change reads the failing computer's own nickname from the machine registry and includes it in storage refusals and failure notices. For example: “Mac Studio is nearly out of disk space, so the file wasn't stored.” If the registry cannot be read during the storage failure, the computer's host name provides a useful fallback. It never borrows the name of whichever machine currently coordinates the agent.

The error still means exactly what it meant before. The amount of required free space, storage limits, retries, notification frequency and cleanup behavior stay the same. A forwarded error keeps the name of the machine where it originated. Internal paths stay private in generic HTTP error replies. Reading a name does not create identity files or change any machine settings.

Tests cover the original phone upload, both storage-capacity branches, paste limits, write failures, health messages, live nickname changes and a broken registry. This is a small reversible bug fix; reverting it requires no state migration. It adds no disk-watch job: that work is tracked separately by the operator.

Release checks also list the new naming helpers explicitly as diagnostic code: they choose words and read names. They do not change the certified delivery or recovery code, whose file hashes and signed test evidence remain unchanged.

The naming also applies when storage is unavailable for reasons beyond free space: a database is locked or read-only, a directory is missing, or a file cannot be opened. These errors still keep their original meaning and code.
