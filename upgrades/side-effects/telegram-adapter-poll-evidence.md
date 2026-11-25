# Record Telegram evidence before advancing the poll cursor

The Telegram adapter accepts an optional synchronous evidence recorder. When supplied, direct polling requests edit updates and calls the recorder on raw updates before any routing or cursor movement. The only caller in this checkpoint is a test.

- Authority. The callback cannot approve or send. The eventual integration must bind a verified bot account, owner and evidence store and enforce continuous edit coverage.
- Failure. A callback exception stops the current batch and preserves the failed update for retry. Ordinary Telegram routing uses its original subscription when the recorder is absent.
- Rollback. No live configuration, endpoint or installed schema changes.

Recorder mode also rejects a cursor range mismatch before the legacy correction can acknowledge updates. Future activation must additionally fence cursor adoption from a prior poller.

Independent review concurred after the cursor range regression was added.
