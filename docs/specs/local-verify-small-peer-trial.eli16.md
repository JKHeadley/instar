# Let the Mac Mini help test changes

The Mini has sixteen gigabytes of memory. It can be quiet while the Studio has hours of testing queued, but starting an ordinary full test run could crowd out other work on the Mini. This trial gives the Mini one narrowly defined task. It can test one proposed change using a smaller group of workers, while its normal limits continue to protect other jobs. Both computers have to agree that the trial is enabled.

Before accepting a change the Mini measures its own available memory. It keeps measuring while it prepares and runs the tests. If available memory reaches the measured minimum, or the Mini loses the ability to measure it, the Mini stops the test and tells the Studio to try again when capacity is available. A test interrupted for memory pressure supplies no evidence that the change passed or failed.

The first three attempts will show how long the work took, how much memory the test processes used together and how low the Mini's available memory fell. Those observations will help the operator decide whether this setting can stay on. Turning it off ends the experiment.
