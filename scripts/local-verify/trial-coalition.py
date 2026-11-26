"""Read and signal one Darwin launchd resource coalition. Invoked by the trusted verifier."""
import ctypes as c
import errno
import json
import os
import signal
import sys

lib = c.CDLL("/usr/lib/libproc.dylib", use_errno=True)
system = c.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
# XNU proc_info_private.h: PROC_PIDUNIQIDENTIFIERINFO and PROC_PIDCOALITIONINFO.
def info(pid, flavor, size):
    data = c.create_string_buffer(size)
    length = lib.proc_pidinfo(pid, flavor, 0, data, size)
    if length != size:
        raise OSError(c.get_errno() or errno.EIO, "proc_pidinfo")
    return data.raw


def coalition(pid):
    return int.from_bytes(info(pid, 20, 40)[:8], sys.byteorder)


def generation(pid):
    return int.from_bytes(info(pid, 17, 56)[32:36], sys.byteorder)


def live_counts(cid):
    # The first two uint64_t fields of coalition_resource_usage are tasks_started/exited.
    counts = (c.c_uint64 * 2)()
    if system.coalition_info_resource_usage(c.c_uint64(cid), counts, c.c_size_t(c.sizeof(counts))) != 0:
        if c.get_errno() == errno.ESRCH:
            return None
        raise OSError(c.get_errno(), "coalition_info_resource_usage")
    if counts[1] > counts[0]:
        raise ValueError("invalid coalition counters")
    return tuple(counts)


def list_pids():
    count = lib.proc_listallpids(None, 0)
    if count <= 0:
        raise OSError(c.get_errno(), "proc_listallpids")
    pids = (c.c_int * (count * 2 + 64))()
    read = lib.proc_listallpids(pids, c.sizeof(pids))
    if read <= 0 or read >= len(pids):
        raise ValueError("process inventory unavailable or truncated")
    return pids[:read]


def snapshot(cid, *, require_complete=True):
    before = live_counts(cid)
    if before is None or before[0] == before[1]:
        return []
    rows = []
    for pid in list_pids():
        try:
            if pid <= 1 or coalition(pid) != cid:
                continue
            version = generation(pid)
            # PROC_PIDTASKINFO begins with virtual_size then resident_size. Ask for
            # the whole ABI struct and reject a short read.
            task = c.create_string_buffer(256)
            size = lib.proc_pidinfo(pid, 4, 0, task, c.sizeof(task))
            if size < 16:
                continue
            rss = int.from_bytes(task.raw[8:16], sys.byteorder)
            if generation(pid) == version and coalition(pid) == cid:
                rows.append(dict(pid=pid, generation=version, rssBytes=rss))
        except OSError:
            # If this was a member, the independent kernel count will reject the sample.
            continue
    if require_complete and (before != live_counts(cid) or before[0] - before[1] != len(rows)):
        raise ValueError("coalition membership changed or contains unmeasurable tasks")
    return rows


def main():
    op = sys.argv[1]
    if op == "identify":
        pid = int(sys.argv[2])
        cid = coalition(pid)
        if cid == 0 or cid == coalition(os.getpid()):
            raise ValueError("runner requires a dedicated coalition")
        return str(cid)
    cid = int(sys.argv[2])
    if cid <= 0 or cid == coalition(os.getpid()):
        raise ValueError("invalid or shared coalition")
    if op == "sample":
        return snapshot(cid)
    if op not in ("TERM", "KILL"):
        raise ValueError("unknown operation")
    # A stale PID cannot signal a replacement process: the kernel compares the
    # pidversion in the audit token before delivering the signal.
    for member in snapshot(cid, require_complete=False):
        token = (c.c_uint32 * 8)()
        token[5], token[7] = member["pid"], member["generation"]
        result = lib.proc_signal_with_audittoken(c.byref(token), getattr(signal, "SIG" + op))
        if result not in (0, errno.ESRCH):
            raise OSError(result, "proc_signal_with_audittoken")
    return None


if __name__ == "__main__":
    print(json.dumps(main()))
