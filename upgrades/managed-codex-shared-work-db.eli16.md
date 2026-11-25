# Ordinary rounds can see an existing continuation hold

When an ordinary project round is about to start, the server now opens the saved records for managed continuation if that store already exists. A managed worker might still be running after someone turns continuation off, so the ordinary launcher continues to respect the saved hold.

An agent that has never used the store still starts ordinary rounds as before. If the store was set up and its file is missing, damaged, or linked somewhere unexpected, the launch stops and the server records a warning. The tests start managed work in a disposable project and check that an ordinary worker using a second database connection cannot start the same round. Production still needs the managed launch path. The scheduler currently discovers a hold after it has already counted the scheduled attempt.
