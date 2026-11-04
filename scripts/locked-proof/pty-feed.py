#!/usr/bin/env python3
"""Answer a command's password prompt(s) from stdin, through a pseudo-terminal.

Used so a secret never appears on a command line (visible in `ps`) or in a log:
`sysadminctl -addUser ... -password -` prompts on its terminal, and this feeds it.

Usage: <secret on stdin> | pty-feed.py [--prompts N] [--timeout S] -- command args...
Answers up to N prompts (default 1) that contain "assword"; prints nothing the child
writes (a prompt could echo); exits with the child's status. Fails if no prompt came.
"""
import os, pty, select, sys, time

def main():
    argv = sys.argv[1:]
    prompts, timeout = 1, 60.0
    while argv and argv[0] != '--':
        if argv[0] == '--prompts': prompts = int(argv[1]); argv = argv[2:]
        elif argv[0] == '--timeout': timeout = float(argv[1]); argv = argv[2:]
        else: sys.exit('pty-feed: unknown option %s' % argv[0])
    if not argv or argv[0] != '--' or len(argv) < 2:
        sys.exit('pty-feed: usage: pty-feed.py [--prompts N] [--timeout S] -- command args...')
    cmd = argv[1:]
    secret = sys.stdin.buffer.read().rstrip(b'\n')
    if not secret:
        sys.exit('pty-feed: empty secret on stdin')
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)
    answered, buf, deadline = 0, b'', time.time() + timeout
    while True:
        if time.time() > deadline:
            os.kill(pid, 9)
            sys.exit('pty-feed: timed out after %d prompt(s)' % answered)
        r, _, _ = select.select([fd], [], [], 0.2)
        if fd in r:
            try:
                chunk = os.read(fd, 1024)
            except OSError:
                break
            if not chunk:
                break
            buf = (buf + chunk)[-256:]
            if answered < prompts and b'assword' in buf:
                os.write(fd, secret + b'\n')
                answered += 1
                buf = b''
        else:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                code = os.waitstatus_to_exitcode(status)
                if answered == 0: sys.exit('pty-feed: the command never asked for a password')
                sys.exit(code)
    _, status = os.waitpid(pid, 0)
    if answered == 0:
        sys.exit('pty-feed: the command never asked for a password')
    sys.exit(os.waitstatus_to_exitcode(status))

if __name__ == '__main__':
    main()
