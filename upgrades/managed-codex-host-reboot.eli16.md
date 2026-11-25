# Clear an old round hold after a computer reboot

A server restart can leave a project worker alive. A computer reboot ends the old worker and its child processes. The round launcher can now save the computer’s identity and the operating system’s boot identifier with a hold. When the same computer later reports a different operating system boot, a new launch can safely clear that old hold.

The check leaves a hold in place if only the server restarted, the computer changed, the proof is missing, or the boot identifier is invalid. Tests exercise all those cases and confirm that a newer worker cannot lose its hold. This change covers ordinary round workers in the test composition. Production still needs to supply the trusted local machine and operating system information before this path can run for real projects.
