# Keep usage reporting responsive while scanning transcripts

The usage ledger reads conversation files to count model usage. A file with a large unread section could briefly prevent the server from answering other requests. The server now reads and parses those sections in a background worker, applies small batches, and records where each batch finished. An unfinished line waits until a later pass completes it. Larger backlogs can take several passes while the server continues answering requests.

A normal scan reads only the part of a file that was added since the last successful pass. The first scan of a new or replaced file may need to start from the beginning. That is the expensive case the worker handles. The server saves each batch and its place in the file together, so a retry can pick up where it left off. The worker reads local files and returns the small set of fields needed to count usage. It has no network role.

Two Studio stalls overlapped ledger scans. The server logs show the duration of each full scan, including time spent waiting on disk and other server work. Those timestamps motivated the fix. They do not identify which callback caused either stall. The release decision is whether the tested change preserves usage totals and keeps the server responsive while it catches up.

If the scanner cannot send a request to the worker, it cleans up the worker and returns the original error to the scan. The repository check now recognizes that error path.
