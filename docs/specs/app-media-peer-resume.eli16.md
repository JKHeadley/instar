# Continue copying an attachment after a restart

When an attachment is copied between two computers, the receiving computer sometimes restarts before the copy finishes. Today, it can keep the file it was working on but forget which computer sent the bytes. It then starts the copy again, even when the original computer is still available.

The fix records which computer sent the verified portion and how much of it was written to disk. After a restart, the receiver checks that the source is still the same authorized computer and that the partial file matches its record. If either check fails, it starts again from the beginning. Before making the attachment available, it still checks that the complete file matches the original exactly and that the attachment still belongs to a conversation that needs it.

The change uses the existing file-size limit and copying rules. It does not change what people can upload, who can read an attachment, or how the apps show a copy in progress.
