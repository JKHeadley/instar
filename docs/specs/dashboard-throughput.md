# Dashboard Throughput

The read-only `GET /throughput/series?days=7|14|30` endpoint returns daily per-author and team delivery metrics for `JKHeadley/instar`. The dashboard Throughput tab renders one responsive time-series bar chart per metric plus the composite index, with team/Codey/Echo and window selectors. The index is window-normalized using V40/S20/Q25/O15: volume, speed, quality, and output.
