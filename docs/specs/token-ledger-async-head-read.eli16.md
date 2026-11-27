# Keep the Laptop responsive while checking transcript fingerprints

The token ledger keeps its place in each transcript so it only counts new records. Before it resumes a file, it checks the first 256 bytes to make sure the file still matches that place. The Laptop's captured profile assigned about 1.5 seconds to those fingerprint checks. A file can be slow to open or read even when the amount of data is small.

The scheduled scan now opens the file, checks its metadata, and reads the fingerprint asynchronously. The server can keep answering requests while those disk operations finish. If the file matches the saved checkpoint, the ledger keeps its original place. If the content changed, the existing replacement logic starts from the beginning and deduplicates usage records. A scan interrupted during the fingerprint check leaves the existing checkpoint available for the next scan.

The test holds a fingerprint read open and checks that the heartbeat still runs. It then resumes the scan and checks that a same-size replacement is counted exactly once. The token routes and saved checkpoint format stay the same.
