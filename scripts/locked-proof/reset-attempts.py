#!/usr/bin/env python3
"""Reset the locked-screen attempt counter for the proof run (plan section 4.4).

Runs AS the throwaway proof user, under the helper's own kernel lock (state.lock),
with the helper's own atomic write. Refuses while any relock duty is open.
Usage: reset-attempts.py --execute <locked-store-root>
Refuses without --execute, and refuses any store other than the proof user's
(/Users/instarproof/.instar/desktop-helper/locked). Tests may name one extra root
inside the system temporary directory through LOCKED_PROOF_TEST_ROOT.
"""
import datetime, fcntl, json, os, sys, tempfile

PROOF_STORE = '/Users/instarproof/.instar/desktop-helper/locked'

def allowed(root):
    real = os.path.realpath(root)
    if real == PROOF_STORE:
        return True
    test = os.environ.get('LOCKED_PROOF_TEST_ROOT')
    tmp = os.path.realpath(tempfile.gettempdir())
    return bool(test) and real == os.path.realpath(test) and real.startswith(tmp + os.sep) \
        and real.endswith(os.sep + os.path.join('.instar', 'desktop-helper', 'locked'))

def main():
    args = sys.argv[1:]
    if '--execute' not in args:
        sys.exit('refusing: dry run (no --execute); nothing reset')
    args = [a for a in args if a != '--execute']
    if len(args) != 1:
        sys.exit('usage: reset-attempts.py --execute <locked-store-root>')
    root = args[0]
    if not allowed(root):
        sys.exit('refusing: %s is not the proof user\'s locked store' % root)
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
