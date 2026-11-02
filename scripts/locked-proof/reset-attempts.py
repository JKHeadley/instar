#!/usr/bin/env python3
"""Reset the locked-screen attempt counter for the proof run (plan section 4.4).

Runs AS the throwaway proof user, under the helper's own kernel lock (state.lock),
with the helper's own atomic write. Refuses while any relock duty is open.
Usage: reset-attempts.py <locked-store-root>
"""
import datetime, fcntl, json, os, sys

def main():
    root = sys.argv[1]
    if not root.rstrip('/').endswith('/.instar/desktop-helper/locked'):
        sys.exit('refusing: not a desktop-helper/locked store')
    fd = os.open(os.path.join(root, 'state.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    path = os.path.join(root, 'locked-state.json')
    state = {}
    if os.path.exists(path):
        with open(path) as f:
            state = json.load(f)
    for key, marker in (state.get('markers') or {}).items():
        if (marker or {}).get('state') in ('owed', 'executing', 'watching'):
            sys.exit('refusing: duty %s is %s' % (key, marker['state']))
    state['attempts'] = {'day': datetime.date.today().isoformat(), 'count': 0, 'perRequest': {}}
    tmp = '%s.%d.tmp' % (path, os.getpid())
    with open(tmp, 'w') as f:
        json.dump(state, f)
    os.chmod(tmp, 0o600)
    os.rename(tmp, path)

if __name__ == '__main__':
    main()
