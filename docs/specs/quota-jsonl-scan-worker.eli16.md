# Keep the server responsive while it estimates Claude usage

When Claude does not return an official usage reading, Instar can estimate weekly usage from local conversation files. The Laptop has more than eleven thousand recent files. Reading them takes time, and parsing their contents in the server process's main thread can slow the requests that keep the testing machines connected.

The same estimate now runs in a separate worker thread. The server stays available while the worker reads the files. The official quota reading still comes first. If the fallback scanner fails or times out, the estimate is unavailable and the server reports that through the existing failure path.

The worker returns only the weekly estimate and its source. It does not send conversation text to a provider or change when any job, account move, or migration is allowed.
