# Keep the Explanation When a Test Fails

When an automatic test run fails, it already tells us which file failed. The detailed report, including the assertion, was deleted as soon as the run stopped. That left us guessing whether a later failure was the same race or a different bug.

This small change keeps a private JSON file beside the failed checkout. It records the failing file, test name, and bounded error text before cleanup can erase it. The complete stored file is limited to 64 KiB, measured as UTF-8 bytes. If some entries do not fit within that limit, the file says that evidence was omitted. File-level collection errors also appear when available.

The artifact follows the existing retained failed checkout. The normal retention limit remains three failed checkouts, and the artifact is removed when that checkout is evicted from the retention list. Existing behavior that preserves unlisted checkouts when the retention registry is corrupt remains unchanged and still needs repair.

This is diagnostic data only. The test verdict, merge requirements, and any user's permissions do not change. The file is written with private permissions and exclusive creation. If writing it fails, the verifier reports that evidence could not be saved and preserves the actual test outcome. No credentials or publication tokens are added. No automatic deployment is part of this change.

The change is diagnostic only and does not change the test result or authorize a merge.
