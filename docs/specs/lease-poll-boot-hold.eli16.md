# A standby waits for the lease before it polls

Only one machine at a time should collect Telegram messages. A backup machine should stay quiet and start collecting only when it takes over.

Today it cannot do both. When a backup starts up, it collects messages straight away until a later check tells it to stop. The only setting that prevents that also stops it from ever collecting, even after a takeover.

Now, when the feature that follows the lease is switched on, a machine waits to hear whether it is in charge before it collects anything. If it hears nothing for 3 minutes, it collects anyway, so a machine on its own is never left deaf. The feature is off by default, so nobody's agent changes.

This also makes starting safer. Getting ready to collect can take up to a minute, and in that time the machine could try to start again, or be told it is no longer in charge. Now only one start can be waiting, it is dropped if the machine stops being in charge, and an old collecting loop cannot carry on beside a new one.

This does not switch takeover on, and it has not been tried on real machines yet. That happens in the power-off and link-cut tests.
