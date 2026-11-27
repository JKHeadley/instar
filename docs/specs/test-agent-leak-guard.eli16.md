# Test-agent leak guard — the plain version

## What went wrong

Another agent ran a release check. To do it, it made a throwaway Instar agent called "rtcheck" in a
temporary folder, started it twice, and stopped it twice. It also told the program that its home
folder was that temporary folder, so it would not touch the real one.

That trick did not work for two things. The Mac's "start this when you log in, and restart it if it
stops" system (launchd) belongs to the person logged in, not to whatever folder a program calls home.
And the Claude login is stored in the Mac's keychain, which also belongs to the person. When the
throwaway agent started, its server noticed that no start-on-login entry existed and helpfully
installed one. That entry was loaded into the real login system. From then on the Mac kept the
throwaway agent running. Because the Mac starts things with the person's real home folder, the
restarted agent looked for its entry in the real home, did not find it there, and installed a second
one there too.

Nobody was watching that agent. For five days it ran its scheduled jobs about 27 times an hour, all
on the operator's real Claude subscription. That was about 12% of all Claude use that week.

## What this change does

1. **No start-on-login for a throwaway.** If an agent lives in a temporary folder, or the program was
   told a fake home folder, Instar refuses to install the start-on-login entry. This check sits in the
   one function every installer goes through, so the server, the lifeline and the updater can no
   longer install it by accident. A person can still force it on purpose.
2. **No surprise start-on-login after a scripted setup.** When `instar init` runs without a person at
   the keyboard, it writes down "do not install start-on-login by yourself". The normal setup wizard
   already asks for start-on-login explicitly afterwards, so real new agents still get it.
3. **Throwaway agents expire.** An agent made in a temporary folder gets an expiry time when it is
   created (24 hours unless told otherwise). Once that time passes, its server and lifeline remove
   their own start-on-login entry (only the one that points at that agent's folder), write a short
   note, and stop for good.
4. **Throwaway agents do not run scheduled jobs.** An agent that lives in a temporary folder skips
   every scheduled job, because Instar cannot tell whether the session would use the operator's real
   login, so it assumes it would. A test that really needs jobs can turn this off with one setting.

## What it does not change

Agents in normal folders, made by a person or by the setup wizard, behave as before. Nothing is
shared between machines here; it is all about one Mac or Linux box. Undoing it is reverting the
change; an agent that already expired stays stopped, which is the point.
