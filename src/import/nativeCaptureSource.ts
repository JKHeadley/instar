import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

export const captureIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Node does not expose openat(2). The fixed helper inherits the already-open installation root
 * as fd 3; only the validated server capture UUID and expected length are supplied as arguments.
 * The pilot has no interpreter discovery and fails closed without its installed system Python. */
const readCapture = `
import os, stat, sys
def checked_directory(parent, name, private):
    fd = os.open(name, os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
    st = os.fstat(fd)
    if st.st_uid != os.getuid() or st.st_mode & (0o077 if private else 0o022):
        raise ValueError()
    return fd
try:
    app = checked_directory(3, 'Instar', False)
    captures = checked_directory(app, 'acquisition', True)
    selected = checked_directory(captures, sys.argv[1], True)
    file = os.open('export.zip', os.O_NOFOLLOW | os.O_RDONLY | os.O_NONBLOCK, dir_fd=selected)
    before = os.fstat(file)
    if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
        or before.st_mode & 0o077 or before.st_nlink != 1 or before.st_size != int(sys.argv[2])):
        raise ValueError()
    remaining = before.st_size
    while remaining:
        chunk = os.read(file, min(262144, remaining))
        if not chunk: raise ValueError()
        sys.stdout.buffer.write(chunk)
        remaining -= len(chunk)
    after = os.fstat(file)
    if os.read(file,1) or before.st_mtime_ns != after.st_mtime_ns or after.st_nlink != 1:
        raise ValueError()
    sys.stdout.buffer.flush()
except BaseException:
    sys.exit(65)
`;

/** Installation-owned root, never taken from a capture, request, URL or environment variable. */
export class NativeCaptureSource {
  private readonly fd: number;
  constructor(applicationSupportRoot: string) {
    if (process.platform !== 'darwin' || !process.getuid || !path.isAbsolute(applicationSupportRoot)
      || fs.realpathSync.native(applicationSupportRoot) !== applicationSupportRoot) throw new Error('capture-root-unavailable');
    this.fd = fs.openSync(applicationSupportRoot,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    try {
      const root = fs.fstatSync(this.fd);
      const named = fs.lstatSync(applicationSupportRoot);
      if (root.dev !== named.dev || root.ino !== named.ino || root.uid !== process.getuid() || (root.mode & 0o022)) {
        throw new Error('capture-root-unavailable');
      }
    } catch (error) { fs.closeSync(this.fd); throw error; }
  }

  read(id:string, size:number, signal:AbortSignal): Readable {
    if (!captureIdPattern.test(id) || !Number.isSafeInteger(size) || size <= 0) throw new Error('invalid-capture-receipt');
    signal.throwIfAborted();
    const child = spawn('/usr/bin/python3',['-I','-S','-c',readCapture,id,String(size)],{
      stdio:['ignore','pipe','ignore',this.fd],env:{PATH:'/usr/bin:/bin'},signal,
    });
    const closed = new Promise<boolean>(resolve => {
      child.once('error',() => resolve(false));
      child.once('close',code => resolve(code === 0));
    });
    return Readable.from((async function* () {
      try {
        for await (const chunk of child.stdout!) yield chunk;
        if (!await closed) throw new Error('capture-file-unavailable');
      } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
    })());
  }

  close(): void { fs.closeSync(this.fd); }
}
