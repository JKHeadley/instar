# Small-peer launch memory margin

Chief requested a sustained 7.5 GB startup threshold following a measured 1.8 GB startup cost. The Mini remains quarantined today.

The optional signed trial field is `startFloorBytes`. An enrolled peer requires four fresh normal-pressure samples across three one-second intervals before launch. Gates and lease ownership are checked again after sampling. The runtime floor and reserve remain separate. Other peers and earlier policies keep their existing behavior.

The coordinator and peer must receive matching policies after both run the new verifier. To roll back the start threshold, remove only the optional field on both machines while the trial is idle. Restore quarantine if the first authorized run cannot maintain its runtime floor. Collect synchronized host, worker-group and resident process measurements during the first 12 seconds of that run.
