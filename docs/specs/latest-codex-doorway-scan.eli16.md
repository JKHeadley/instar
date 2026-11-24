# A doorway scan that works from an installed release

Instar uses a reviewed catalog to decide which models are supported. A separate doorway scan checks which providers this computer can currently reach. Today some parts of that scan assume the computer has a copy of Instar's source repository, which ordinary installations may lack.

This change makes Instar use the scanner and catalog that came with its installed release. Before it starts a scheduled check, it confirms that those files belong to the release and reads the on-off setting from the same directory where the server stores the agent's state. The check uses free probes and records which computer made the observation. It does not add any model to the reviewed catalog.

An update preserves existing choices. If you turned the scan off, it stays off, even if your installation predates the setting that records exactly when you disabled it. If you picked a schedule, Instar keeps that schedule. A fresh schedule starts disabled until enabled through the existing job controls. For a scan that already runs, the update preserves how changes reach you. The scheduled scan stores its observations separately so that it cannot accidentally mark a manual notice as delivered. The registry shows the latest valid observation along with the computer that supplied it.
