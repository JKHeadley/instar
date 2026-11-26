# Durable unit process evidence

Unit shards receive bounded prefix and suffix capture. Other process steps use the existing tail. The additional capture retains up to 2 MiB of prefix and 64 KiB of suffix per stream. It is kept only for nonzero unit exits without named failed files. The archive is separate from failed checkout pruning and retains eight files in a private directory. Test output is written to a private file and only its location is logged.

The evidence path has no authority over outcomes, retry eligibility, or merges. An unavailable archive is logged and the original verdict is preserved. Rollback removes capture and retention wiring. Existing files remain private until cleaned through ordinary host maintenance.
