#!/usr/bin/python3
# x-drive.py: the Linux normal-Chrome driver (ACT-138). Run it through xdrive.sh, never directly.
# Installed by instar into .instar/scripts/browser/, overwritten on every update.
#
# It reads pages through the accessibility tree (AT-SPI) and acts through real X input (XTEST) on a
# private virtual display this agent owns, so a click carries user activation and no person shares the
# keyboard or pointer. There is no page-world JavaScript, no CDP and no WebDriver.
#
# These rules are guardrails against an honest agent's mistakes (wrong window, wrong page, a stale
# coordinate, text on argv). They are not a boundary against other code running as the same Linux user.
# Standards: docs/specs/normal-chrome-linux.md, docs/specs/normal-chrome-cross-platform.md.
#
# Layout: the rule functions come first and import nothing beyond the standard library, so they run and
# are tested on any OS. Everything that needs X or AT-SPI sits below and loads only on Linux.
import ctypes
import hashlib
import json
import os
import re
import resource
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
import unicodedata
from urllib.parse import unquote, urlsplit

EXIT_OK, EXIT_ERROR, EXIT_REFUSED, EXIT_CHECK, EXIT_ARG = 0, 1, 2, 3, 64

CREDENTIAL_PARAMS = frozenset((
    'code', 'token', 'access_token', 'id_token', 'refresh_token', 'oobcode', 'api_key', 'apikey', 'key',
    'secret', 'password', 'otp', 'auth', 'sig', 'signature', 'ticket', 'assertion', 'session',
))
NAMED_KEYS = frozenset((
    'Return', 'Tab', 'Escape', 'BackSpace', 'Delete', 'Left', 'Right', 'Up', 'Down', 'Home', 'End',
    'Page_Up', 'Page_Down',
))
ALLOWED_EXTRA_FLAGS = re.compile(r'^(--disable-extensions|--window-size=\d{1,5},\d{1,5}|--lang=[a-z]{2}(-[A-Z]{2})?)$')
PROFILE_ID = re.compile(r'^[a-z0-9-]{1,64}$')
DISPLAY_FIRST, DISPLAY_LAST = 100, 119
SOCKET_PATH_LIMIT = 100
SCREEN_W, SCREEN_H = 1600, 1000
FIND_CANDIDATE_CAP = 200
TEXT_NODE_CAP, TEXT_BYTE_CAP = 200000, 20 * 1024 * 1024
OUT_MAX_AGE_S, OUT_MAX_BYTES, OUT_MIN_AGE_S = 86400, 200 * 1024 * 1024, 600
PER_KEY_SECONDS = 0.02
SECRET_MAX_BYTES = 4096

# The US keymap: every printable ASCII character as (keysym name, shift). Anything else has no keycode here.
_UNSHIFTED = {
    ' ': 'space', '-': 'minus', '=': 'equal', '[': 'bracketleft', ']': 'bracketright', '\\': 'backslash',
    ';': 'semicolon', "'": 'apostrophe', '`': 'grave', ',': 'comma', '.': 'period', '/': 'slash',
}
_SHIFTED = {
    '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
    '_': 'minus', '+': 'equal', '{': 'bracketleft', '}': 'bracketright', '|': 'backslash', ':': 'semicolon',
    '"': 'apostrophe', '~': 'grave', '<': 'comma', '>': 'period', '?': 'slash',
}


INPUT_SENT = [False]  # set by the backend on the first real event, so a later refusal keeps the latch


class Refuse(Exception):
    """A deterministic refusal: the message is safe to print and the exit code is part of the contract."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def us_key(ch):
    """(keysym name, shift) for one character, or None when the US keymap cannot type it."""
    if len(ch) != 1:
        return None
    if 'a' <= ch <= 'z' or '0' <= ch <= '9':
        return (ch, False)
    if 'A' <= ch <= 'Z':
        return (ch.lower(), True)
    if ch in _UNSHIFTED:
        return (_UNSHIFTED[ch], False)
    if ch in _SHIFTED:
        return (_SHIFTED[ch], True)
    return None


def require_typable(text):
    """Refuse before any key goes down. The character is never named: this also guards secrets."""
    for ch in text:
        if us_key(ch) is None:
            raise Refuse(EXIT_REFUSED, 'ERR untypable-character: the text holds a character the private display\'s US layout cannot type; nothing was typed')


def require_fits_deadline(length, deadline_s):
    if length * PER_KEY_SECONDS > max(deadline_s - 5, 0):
        raise Refuse(EXIT_REFUSED, 'ERR text-exceeds-deadline: this text would outlast the command time limit; nothing was typed')


def escape_page(value):
    """Page text can never forge a driver line: controls, format and separator characters are escaped."""
    out = []
    for ch in value or '':
        if unicodedata.category(ch) in ('Cc', 'Cf', 'Zl', 'Zp'):
            out.append('\\u%04x' % ord(ch))
        else:
            out.append(ch)
    return ''.join(out)


def _param_name(part):
    return unquote(part.split('=', 1)[0]).strip().lower()


def has_credential_param(url):
    for chunk in re.split(r'[?&#;]', url)[1:]:
        if '=' in chunk and _param_name(chunk) in CREDENTIAL_PARAMS:
            return True
    return False


def redact_uri(uri):
    """Replace the value of every credential-shaped query or fragment parameter."""
    if not uri:
        return ''

    def fix(match):
        lead, name = match.group(1), match.group(2)
        if unquote(name).strip().lower() in CREDENTIAL_PARAMS:
            return lead + name + '=[redacted]'
        return match.group(0)

    return re.sub(r'([?&#;])([^=?&#;]+)=([^&#;]*)', fix, uri)


def check_url(url):
    """The url rule for launch and nav. The url is never echoed in a refusal."""
    if not url or re.search(r'[\s"\'`\x00-\x1f\x7f]', url):
        raise Refuse(EXIT_ARG, 'ERR bad-url: a url holds no whitespace, quote or control character (the url is not echoed)')
    if not re.match(r'^(https?://.|about:.|chrome://.|file://.)', url, re.IGNORECASE):
        raise Refuse(EXIT_ARG, 'ERR bad-url: a url starts https://, http://, about:, chrome:// or file://, and a Chrome flag is never accepted here (the url is not echoed)')
    if has_credential_param(url):
        raise Refuse(EXIT_ARG, 'ERR secret-shaped-url: the url carries a credential-shaped parameter, and a url on argv is readable by every process on the machine')
    return url


def is_browser_ui_document(uri):
    """Chrome draws parts of its own interface as web documents, such as the address bar's dropdown
    at chrome://omnibox-popup.top-chrome/. They are not pages and not tabs."""
    return uri.startswith('chrome://') and uri_host(uri).endswith('.top-chrome')


def uri_host(uri):
    try:
        return (urlsplit(uri).hostname or '').lower().rstrip('.')
    except ValueError:
        return ''


def check_secret_destination(uri, expected_host):
    """typesecret's destination rule: https, default port, and the host equal to the named one, no suffix match."""
    expected = (expected_host or '').strip().lower().rstrip('.')
    if not expected or not re.match(r'^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$', expected):
        raise Refuse(EXIT_ARG, 'ERR bad-argument: typesecret needs the expected host, such as accounts.example.com')
    try:
        parts = urlsplit(uri or '')
        port = parts.port
    except ValueError:
        raise Refuse(EXIT_REFUSED, 'ERR host-mismatch: the page is not https on the expected host; nothing was typed')
    if parts.scheme.lower() != 'https' or port not in (None, 443) or uri_host(uri) != expected:
        raise Refuse(EXIT_REFUSED, 'ERR host-mismatch: the page is not https on the expected host; nothing was typed')


def read_secret(stream):
    """All of stdin as a mutable buffer, so it can be overwritten. One line only: a second line is refused,
    never silently dropped, because the submission is consumed on success."""
    raw = bytearray(stream.read(SECRET_MAX_BYTES + 1))
    if len(raw) > SECRET_MAX_BYTES:
        wipe(raw)
        raise Refuse(EXIT_REFUSED, 'ERR bad-secret: the value is too long; nothing was typed')
    if raw and raw[-1] == 10:
        raw.pop()
    if raw and raw[-1] == 13:
        raw.pop()
    if not raw or 10 in raw or 13 in raw:
        wipe(raw)
        raise Refuse(EXIT_REFUSED, 'ERR bad-secret: the value must be one non-empty line; nothing was typed')
    return raw


def wipe(buffer):
    for i in range(len(buffer)):
        buffer[i] = 0


def resolve_profile(home, profile_id, must_exist=True):
    """The profile jail: an id, inside this agent's profiles folder, with no symlink out."""
    if not PROFILE_ID.match(profile_id or ''):
        raise Refuse(EXIT_ARG, 'ERR bad-profile-path: a profile id is lowercase letters, digits and dashes')
    root = os.path.realpath(os.path.join(home, '.instar', 'state', 'playwright-profiles'))
    real = os.path.realpath(os.path.join(root, profile_id))
    if os.path.dirname(real) != root:
        raise Refuse(EXIT_ARG, 'ERR profile-outside-agent-home: that profile resolves outside this agent\'s profiles folder')
    if must_exist and not os.path.isdir(real):
        raise Refuse(EXIT_REFUSED, 'ERR no-profile: no such profile; add --new only when the operator asked for a new one')
    return real


def check_outfile(home, path):
    out = os.path.join(os.path.realpath(home), '.instar', 'state', 'xdrive', 'out') + os.sep
    if not path or not os.path.isabs(path) or '..' in path.split(os.sep) or re.search(r'[\x00-\x1f\x7f]', path):
        raise Refuse(EXIT_ARG, 'ERR bad-outfile: give an absolute path under .instar/state/xdrive/out/')
    real = os.path.join(os.path.realpath(os.path.dirname(path)), os.path.basename(path))
    if not real.startswith(out):
        raise Refuse(EXIT_ARG, 'ERR bad-outfile: give an absolute path under .instar/state/xdrive/out/')
    return real


def check_extra_flags(value):
    flags = (value or '').split()
    for flag in flags:
        if not ALLOWED_EXTRA_FLAGS.match(flag):
            raise Refuse(EXIT_ARG, 'ERR bad-argument: XD_CHROME_FLAGS allows only --disable-extensions, --window-size=W,H and --lang=xx')
    return flags


def parse_start_time(stat_text):
    """Field 22 of /proc/<pid>/stat. The command name may hold spaces and parentheses, so split after the last )."""
    return stat_text.rsplit(')', 1)[1].split()[19]


def proc_start_time(pid, proc='/proc'):
    try:
        with open('%s/%d/stat' % (proc, int(pid)), 'r', errors='replace') as handle:
            return parse_start_time(handle.read())
    except (OSError, ValueError, IndexError):
        return None


def pick_display(socket_exists, lock_pid_alive):
    """The first free number: no socket, and no lock file naming a live process."""
    for number in range(DISPLAY_FIRST, DISPLAY_LAST + 1):
        if not socket_exists(number) and not lock_pid_alive(number):
            return number
    raise Refuse(EXIT_REFUSED, 'ERR no-x-server: no free display number from 100 to 119')


def signal_recorded(processes, read_start, kill, sleep=time.sleep, grace_s=5.0):
    """Stop only recorded processes whose start time still matches; a mismatch is another process."""
    live = [p for p in processes if read_start(p['pid']) == p['start']]
    for proc in live:
        kill(proc['pid'], signal.SIGTERM)
    waited = 0.0
    while waited < grace_s and any(read_start(p['pid']) == p['start'] for p in live):
        sleep(0.1)
        waited += 0.1
    for proc in live:
        if read_start(proc['pid']) == proc['start']:
            kill(proc['pid'], signal.SIGKILL)
    return [p['pid'] for p in live]


def xauth_entry(hostname, number, cookie):
    """One MIT-MAGIC-COOKIE-1 record, family local, for this display number only."""
    def field(data):
        return struct.pack('>H', len(data)) + data
    return struct.pack('>H', 256) + field(hostname.encode()) + field(str(number).encode()) + field(b'MIT-MAGIC-COOKIE-1') + field(cookie)


def xvnc_args(binary, number, auth_file):
    return [
        binary, ':%d' % number, '-auth', auth_file, '-nolisten', 'tcp', '-rfbport', '-1', '-SecurityTypes', 'None',
        '-AcceptKeyEvents=0', '-AcceptPointerEvents=0', '-AcceptCutText=0', '-SendCutText=0',
        '-AcceptSetDesktopSize=0', '-geometry', '%dx%d' % (SCREEN_W, SCREEN_H), '-depth', '24',
    ]


def chrome_args(binary, profile_dir, url, extra):
    return [
        binary, '--user-data-dir=%s' % profile_dir, '--password-store=basic', '--ozone-platform=x11', '--no-first-run',
        '--no-default-browser-check', '--force-renderer-accessibility', '--window-position=0,0',
        '--window-size=%d,%d' % (SCREEN_W, SCREEN_H),
    ] + extra + ['--new-window', url]


def socket_folder(home, uid):
    """The state tree when the path fits a Unix socket, otherwise a private folder under /tmp."""
    preferred = os.path.join(home, '.instar', 'state', 'xdrive', 'run')
    if len(os.path.join(preferred, 'bus').encode()) <= SOCKET_PATH_LIMIT:
        return preferred
    digest = hashlib.sha256(home.encode()).hexdigest()[:12]
    return '/tmp/instar-xdrive-%d-%s' % (uid, digest)


def check_socket_folder(lstat_result, uid):
    if not stat.S_ISDIR(lstat_result.st_mode) or lstat_result.st_uid != uid or stat.S_IMODE(lstat_result.st_mode) != 0o700:
        raise Refuse(EXIT_REFUSED, 'ERR no-x-server: socket folder not ours')


def sweep_outfiles(folder, now=None):
    """Remove outfiles older than 24 h, then the oldest past 10 minutes while over 200 MB."""
    now = time.time() if now is None else now
    entries = []
    for name in os.listdir(folder):
        path = os.path.join(folder, name)
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode):
            continue
        if now - info.st_mtime > OUT_MAX_AGE_S:
            os.unlink(path)
        else:
            entries.append((info.st_mtime, info.st_size, path))
    total = sum(e[1] for e in entries)
    for mtime, size, path in sorted(entries):
        if total <= OUT_MAX_BYTES:
            break
        if now - mtime > OUT_MIN_AGE_S:
            os.unlink(path)
            total -= size


# ---------------------------------------------------------------------------------------------------
# The input backend. Every libX11/libXtst call lives in this class; a Wayland backend implements the
# same methods with coordinate_type() = 'window'. A static check fails on X calls outside it.
# ---------------------------------------------------------------------------------------------------
class X11Backend:
    REVERT_TO_PARENT, CURRENT_TIME, IS_VIEWABLE, USE_CORE_KBD = 2, 0, 2, 0x0100

    class _Attrs(ctypes.Structure):
        _fields_ = [
            ('x', ctypes.c_int), ('y', ctypes.c_int), ('width', ctypes.c_int), ('height', ctypes.c_int),
            ('border_width', ctypes.c_int), ('depth', ctypes.c_int), ('visual', ctypes.c_void_p),
            ('root', ctypes.c_ulong), ('c_class', ctypes.c_int), ('bit_gravity', ctypes.c_int),
            ('win_gravity', ctypes.c_int), ('backing_store', ctypes.c_int), ('backing_planes', ctypes.c_ulong),
            ('backing_pixel', ctypes.c_ulong), ('save_under', ctypes.c_int), ('colormap', ctypes.c_ulong),
            ('map_installed', ctypes.c_int), ('map_state', ctypes.c_int), ('all_event_masks', ctypes.c_long),
            ('your_event_mask', ctypes.c_long), ('do_not_propagate_mask', ctypes.c_long),
            ('override_redirect', ctypes.c_int), ('screen', ctypes.c_void_p),
        ]

    def __init__(self):
        x = ctypes.CDLL('libX11.so.6')
        t = ctypes.CDLL('libXtst.so.6')
        P, U, I, L = ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.POINTER
        x.XOpenDisplay.restype = P
        x.XOpenDisplay.argtypes = [ctypes.c_char_p]
        x.XDefaultRootWindow.restype = U
        x.XDefaultRootWindow.argtypes = [P]
        x.XInternAtom.restype = U
        x.XInternAtom.argtypes = [P, ctypes.c_char_p, I]
        x.XStringToKeysym.restype = U
        x.XStringToKeysym.argtypes = [ctypes.c_char_p]
        x.XKeysymToKeycode.restype = ctypes.c_ubyte
        x.XKeysymToKeycode.argtypes = [P, U]
        x.XQueryTree.argtypes = [P, U, L(U), L(U), L(L(U)), L(ctypes.c_uint)]
        x.XGetWindowAttributes.argtypes = [P, U, L(self._Attrs)]
        x.XGetWindowProperty.argtypes = [P, U, U, ctypes.c_long, ctypes.c_long, I, U, L(U), L(I), L(U), L(U), L(P)]
        x.XGetInputFocus.argtypes = [P, L(U), L(I)]
        x.XQueryPointer.argtypes = [P, U, L(U), L(U), L(I), L(I), L(I), L(I), L(ctypes.c_uint)]
        x.XRaiseWindow.argtypes = [P, U]
        x.XSetInputFocus.argtypes = [P, U, I, U]
        x.XSync.argtypes = [P, I]
        x.XFree.argtypes = [P]
        x.XkbLockModifiers.argtypes = [P, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint]
        x.XkbLockGroup.argtypes = [P, ctypes.c_uint, ctypes.c_uint]
        t.XTestFakeMotionEvent.argtypes = [P, I, I, I, U]
        t.XTestFakeButtonEvent.argtypes = [P, ctypes.c_uint, I, U]
        t.XTestFakeKeyEvent.argtypes = [P, ctypes.c_uint, I, U]
        self.x, self.t = x, t
        # Xlib's default handler exits the process. Chrome opens and closes windows constantly, so a
        # window vanishing between two calls is ordinary: the call fails and the caller sees that.
        self._on_error = ctypes.CFUNCTYPE(I, P, P)(lambda _display, _event: 0)
        x.XSetErrorHandler.argtypes = [P]
        x.XSetErrorHandler.restype = P
        x.XSetErrorHandler(ctypes.cast(self._on_error, P))
        self.dpy = x.XOpenDisplay(None)
        if not self.dpy:
            raise Refuse(EXIT_REFUSED, 'ERR no-x-server: cannot connect to the agent display')
        self.root = x.XDefaultRootWindow(self.dpy)
        self.down_keys, self.down_buttons = [], []

    def coordinate_type(self):
        return 'screen'

    def to_input_point(self, rect, _window):
        return (rect[0] + rect[2] // 2, rect[1] + rect[3] // 2)

    def _tree(self, window):
        root, parent = ctypes.c_ulong(), ctypes.c_ulong()
        kids, count = ctypes.POINTER(ctypes.c_ulong)(), ctypes.c_uint()
        if not self.x.XQueryTree(self.dpy, window, ctypes.byref(root), ctypes.byref(parent), ctypes.byref(kids), ctypes.byref(count)):
            return 0, []
        found = [kids[i] for i in range(count.value)]
        if kids:
            self.x.XFree(ctypes.cast(kids, ctypes.c_void_p))
        return parent.value, found

    def _property(self, window, atom_name, length):
        atom = self.x.XInternAtom(self.dpy, atom_name, 1)
        if not atom:
            return None, 0
        kind, fmt, count, after, data = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_void_p()
        status = self.x.XGetWindowProperty(self.dpy, window, atom, 0, length, 0, 0, ctypes.byref(kind), ctypes.byref(fmt), ctypes.byref(count), ctypes.byref(after), ctypes.byref(data))
        if status != 0 or not data:
            return None, 0
        return data, count.value

    def root_string(self, atom_name):
        data, count = self._property(self.root, atom_name, 4096)
        if data is None:
            return ''
        value = ctypes.string_at(data, count).decode('utf-8', 'replace')
        self.x.XFree(data)
        return value

    def _window_pid(self, window):
        data, count = self._property(window, b'_NET_WM_PID', 1)
        if data is None:
            return None
        value = ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[0] if count else None
        self.x.XFree(data)
        return value

    def geometry(self, window):
        attrs = self._Attrs()
        if not self.x.XGetWindowAttributes(self.dpy, window, ctypes.byref(attrs)):
            return None
        return {'x': attrs.x, 'y': attrs.y, 'w': attrs.width, 'h': attrs.height,
                'viewable': attrs.map_state == self.IS_VIEWABLE, 'override': bool(attrs.override_redirect)}

    def windows_of(self, pid):
        """Mapped, non-override-redirect top-level windows of this process: omnibox lists and menus don't count."""
        found = []
        for window in self._tree(self.root)[1]:
            geo = self.geometry(window)
            if geo and geo['viewable'] and not geo['override'] and self._window_pid(window) == pid:
                found.append(window)
        return found

    def top_level(self, window):
        while window and window != self.root:
            parent = self._tree(window)[0]
            if parent == self.root or not parent:
                return window
            window = parent
        return window

    def focus_window(self, window):
        self.x.XRaiseWindow(self.dpy, window)
        self.x.XSetInputFocus(self.dpy, window, self.REVERT_TO_PARENT, self.CURRENT_TIME)
        self.x.XSync(self.dpy, 0)

    def focused_window(self):
        window, revert = ctypes.c_ulong(), ctypes.c_int()
        self.x.XGetInputFocus(self.dpy, ctypes.byref(window), ctypes.byref(revert))
        return self.top_level(window.value) if window.value > 1 else 0

    def move(self, point):
        self.t.XTestFakeMotionEvent(self.dpy, -1, point[0], point[1], 0)
        self.x.XSync(self.dpy, 0)

    def pointer_window(self):
        root, child = ctypes.c_ulong(), ctypes.c_ulong()
        rx, ry, wx, wy, mask = ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_uint()
        self.x.XQueryPointer(self.dpy, self.root, ctypes.byref(root), ctypes.byref(child), ctypes.byref(rx), ctypes.byref(ry), ctypes.byref(wx), ctypes.byref(wy), ctypes.byref(mask))
        return (child.value, (rx.value, ry.value))

    def button(self, number, down):
        INPUT_SENT[0] = True
        self.t.XTestFakeButtonEvent(self.dpy, number, 1 if down else 0, 0)
        self.x.XSync(self.dpy, 0)
        if down:
            self.down_buttons.append(number)
        elif number in self.down_buttons:
            self.down_buttons.remove(number)

    def key(self, keysym_name, down):
        code = self.x.XKeysymToKeycode(self.dpy, self.x.XStringToKeysym(keysym_name.encode()))
        if not code:
            raise Refuse(EXIT_REFUSED, 'ERR untypable-character: the private display has no such key; typing stopped')
        INPUT_SENT[0] = True
        self.t.XTestFakeKeyEvent(self.dpy, code, 1 if down else 0, 0)
        self.x.XSync(self.dpy, 0)
        if down:
            self.down_keys.append(code)
        elif code in self.down_keys:
            self.down_keys.remove(code)

    def tap(self, keysym_name, shift=False, ctrl=False):
        held = (['Control_L'] if ctrl else []) + (['Shift_L'] if shift else [])
        for name in held:
            self.key(name, True)
        self.key(keysym_name, True)
        self.key(keysym_name, False)
        for name in reversed(held):
            self.key(name, False)

    def type_char(self, ch):
        name, shift = us_key(ch)
        self.tap(name, shift=shift)

    def reset_modifiers(self):
        self.x.XkbLockModifiers(self.dpy, self.USE_CORE_KBD, 0xff, 0)
        self.x.XkbLockGroup(self.dpy, self.USE_CORE_KBD, 0)
        self.x.XSync(self.dpy, 0)

    def release_all(self):
        for code in list(self.down_keys):
            self.t.XTestFakeKeyEvent(self.dpy, code, 0, 0)
        for number in list(self.down_buttons):
            self.t.XTestFakeButtonEvent(self.dpy, number, 0, 0)
        self.down_keys, self.down_buttons = [], []
        self.x.XSync(self.dpy, 0)

    def release_everything(self):
        """After an unknown outcome nothing tracked survives: release buttons 1-5 and every keycode."""
        for number in range(1, 6):
            self.t.XTestFakeButtonEvent(self.dpy, number, 0, 0)
        for code in range(8, 256):
            self.t.XTestFakeKeyEvent(self.dpy, code, 0, 0)
        self.x.XSync(self.dpy, 0)


# ---------------------------------------------------------------------------------------------------
# State and the agent display stack.
# ---------------------------------------------------------------------------------------------------
class State:
    def __init__(self, home):
        self.home = os.path.realpath(home)
        self.root = os.path.join(self.home, '.instar', 'state', 'xdrive')
        self.display_dir = os.path.join(self.root, 'display')
        self.targets = os.path.join(self.root, 'targets')
        self.out = os.path.join(self.root, 'out')
        self.record = os.path.join(self.root, 'display.json')
        self.xauth = os.path.join(self.display_dir, 'Xauthority')
        for path in (self.root, self.display_dir, self.targets, self.out):
            os.makedirs(path, mode=0o700, exist_ok=True)
            os.chmod(path, 0o700)

    def target_file(self, profile_id):
        return os.path.join(self.targets, profile_id + '.json')


def read_json(path):
    try:
        with open(path, 'r') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def write_json(path, value):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def boot_id():
    with open('/proc/sys/kernel/random/boot_id') as handle:
        return handle.read().strip()


def find_binary(names, extra=()):
    for folder in os.environ.get('PATH', '').split(':') + list(extra):
        for name in names:
            path = os.path.join(folder, name)
            if os.access(path, os.X_OK) and not os.path.isdir(path):
                return path
    return None


def launcher_path():
    for path in ('/usr/libexec/at-spi-bus-launcher', '/usr/lib/at-spi2-core/at-spi-bus-launcher'):
        if os.access(path, os.X_OK):
            return path
    return None


def minimal_env(extra):
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': os.environ.get('HOME', ''), 'LANG': os.environ.get('LANG', 'C.UTF-8')}
    env.update(extra)
    return env


def spawn(argv, env):
    return subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)


def _socket_path(number):
    return '/tmp/.X11-unix/X%d' % number


def _lock_pid(number):
    try:
        with open('/tmp/.X%d-lock' % number) as handle:
            return int(handle.read().strip())
    except (OSError, ValueError):
        return None


def _lock_alive(number):
    pid = _lock_pid(number)
    return pid is not None and proc_start_time(pid) is not None


def _peer_pid(number):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(2)
    try:
        sock.connect(_socket_path(number))
        return struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[0]
    except OSError:
        return None
    finally:
        sock.close()


def _display_env(state, record):
    return {
        'DISPLAY': ':%d' % record['display'], 'XAUTHORITY': state.xauth,
        'DBUS_SESSION_BUS_ADDRESS': 'unix:path=%s/bus' % record['sockets'],
    }


def stop_stack(state, record):
    """Only recorded processes, each re-checked by start time. After a reboot nothing is signalled."""
    if record and record.get('boot') == boot_id():
        signal_recorded(record.get('processes', []), proc_start_time, os.kill)
    if record and os.path.isdir(record.get('sockets', '')):
        for name in os.listdir(record['sockets']):
            path = os.path.join(record['sockets'], name)
            if not os.path.isdir(path):
                os.unlink(path)
    if os.path.exists(state.record):
        os.unlink(state.record)


def children_of(pid):
    found = []
    try:
        for task in os.listdir('/proc/%d/task' % pid):
            with open('/proc/%d/task/%s/children' % (pid, task)) as handle:
                found += [int(p) for p in handle.read().split()]
    except OSError:
        pass
    return found


def bound_targets(state):
    live = []
    for name in os.listdir(state.targets):
        target = read_json(os.path.join(state.targets, name))
        if target and proc_start_time(target.get('pid', 0)) == target.get('start'):
            live.append(target)
    return live


def stack_problem(record):
    """The health contract: the first thing wrong, or None."""
    if record.get('boot') != boot_id():
        return 'rebooted'
    if not record.get('processes') or record.get('display') is None:
        return 'unfinished start'
    for proc in record.get('processes', []):
        if proc_start_time(proc['pid']) != proc['start']:
            return proc['name']
    xvnc = record['processes'][0]['pid']
    if _lock_pid(record['display']) != xvnc or _peer_pid(record['display']) != xvnc:
        return 'x server'
    return None


def check_stack(state):
    """Reuse a healthy stack; stop a dead one; never end a running bound Chrome from a health check."""
    record = read_json(state.record)
    if not record:
        return None
    problem = stack_problem(record)
    if problem is None:
        return record
    if not record.get('processes') or record.get('display') is None:
        stop_stack(state, record)
        return None
    xvnc_alive = record.get('boot') == boot_id() and proc_start_time(record['processes'][0]['pid']) == record['processes'][0]['start']
    if xvnc_alive and bound_targets(state):
        raise Refuse(EXIT_REFUSED, 'ERR display-unhealthy: %s' % problem)
    stop_stack(state, record)
    return None


def start_stack(state):
    xvnc = find_binary(('Xvnc', 'Xtigervnc'))
    launcher = launcher_path()
    dbus = find_binary(('dbus-daemon',))
    if not xvnc or not launcher or not dbus:
        raise Refuse(EXIT_REFUSED, 'ERR no-x-server: Xvnc, dbus-daemon or at-spi-bus-launcher is missing; see the install line from xdrive.sh deps')
    sockets = socket_folder(state.home, os.getuid())
    if not os.path.exists(sockets):
        os.makedirs(sockets, mode=0o700)
    check_socket_folder(os.lstat(sockets), os.getuid())
    processes = []

    record = {'display': None, 'boot': boot_id(), 'sockets': sockets, 'processes': processes}

    def track(name, proc):
        # Recorded the moment it exists, so a wrapper killed mid-start leaves nothing unowned.
        processes.append({'name': name, 'pid': proc.pid, 'start': proc_start_time(proc.pid)})
        write_json(state.record, record)

    try:
        for _ in range(DISPLAY_LAST - DISPLAY_FIRST + 1):
            # A socket nobody answers on is left over from a killed server, which the next server clears.
            number = pick_display(lambda n: _peer_pid(n) is not None, _lock_alive)
            fd = os.open(state.xauth, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'wb') as handle:
                handle.write(xauth_entry(socket.gethostname(), number, os.urandom(16)))
            proc = spawn(xvnc_args(xvnc, number, state.xauth), minimal_env({}))
            record['display'] = number
            track('xvnc', proc)
            deadline = time.time() + 10
            while time.time() < deadline and proc.poll() is None and _peer_pid(number) != proc.pid:
                time.sleep(0.05)
            if proc.poll() is None and _peer_pid(number) == proc.pid and _lock_pid(number) == proc.pid:
                break
            if proc.poll() is None:
                proc.kill()
            processes.pop()
            write_json(state.record, record)
        else:
            raise Refuse(EXIT_REFUSED, 'ERR no-x-server: Xvnc did not start')
        env = _display_env(state, record)
        os.environ.update(env)
        track('dbus', spawn([dbus, '--session', '--nofork', '--address=' + env['DBUS_SESSION_BUS_ADDRESS']], minimal_env({})))
        deadline = time.time() + 10
        while time.time() < deadline and not os.path.exists(os.path.join(sockets, 'bus')):
            time.sleep(0.05)
        launched = spawn([launcher, '--launch-immediately'], minimal_env(dict(env, XDG_RUNTIME_DIR=sockets)))
        track('at-spi-bus-launcher', launched)
        backend = X11Backend()
        while time.time() < deadline and not backend.root_string(b'AT_SPI_BUS'):
            time.sleep(0.05)
        if not backend.root_string(b'AT_SPI_BUS'):
            raise Refuse(EXIT_REFUSED, 'ERR no-x-server: the accessibility bus did not start')
        for pid in children_of(launched.pid):
            processes.append({'name': 'at-spi-bus', 'pid': pid, 'start': proc_start_time(pid)})
        write_json(state.record, record)
        enable_accessibility()
        return record
    except Exception:
        stop_stack(state, record)
        raise


def enable_accessibility():
    import gi
    gi.require_version('Gio', '2.0')
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    bus.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.freedesktop.DBus.Properties', 'Set',
                  GLib.Variant('(ssv)', ('org.a11y.Status', 'IsEnabled', GLib.Variant('b', True))), None, Gio.DBusCallFlags.NONE, 5000, None)


# ---------------------------------------------------------------------------------------------------
# AT-SPI: reading and the guarded commands. Nothing here touches X directly; it goes through the backend.
# ---------------------------------------------------------------------------------------------------
class Driver:
    def __init__(self, state, backend, target, wrapper_pid):
        import gi
        import warnings
        warnings.simplefilter('ignore')  # gi deprecation notes on stderr would read as driver output
        gi.require_version('Atspi', '2.0')
        from gi.repository import Atspi, GLib
        self.Atspi, self.GLib = Atspi, GLib
        Atspi.init()
        Atspi.set_timeout(5000, 5000)
        self.state, self.backend, self.target = state, backend, target
        self.wrapper_pid = wrapper_pid
        self.wrapper_start = proc_start_time(wrapper_pid) if wrapper_pid else None
        self.interrupted = False
        self.listener = None

    # -- finding things ---------------------------------------------------------------------------
    def app(self):
        desktop = self.Atspi.get_desktop(0)
        for i in range(desktop.get_child_count()):
            child = desktop.get_child_at_index(i)
            if child is not None and child.get_process_id() == self.target['pid']:
                return child
        raise Refuse(EXIT_REFUSED, 'ERR no-atspi: this Chrome is not on the accessibility bus')

    def _one_window(self):
        windows = self.backend.windows_of(self.target['pid'])
        if len(windows) > 1:
            raise Refuse(EXIT_REFUSED, 'ERR multiple-windows: this Chrome has more than one window; close and relaunch')
        if not windows:
            raise Refuse(EXIT_REFUSED, 'ERR no-target: the bound window is gone')
        return windows[0]

    def frame_and_document(self):
        window = self._one_window()
        geo = self.backend.geometry(window)
        app = self.app()
        chosen, documents = None, []
        for i in range(app.get_child_count()):
            frame = app.get_child_at_index(i)
            if frame is None or frame.get_role() != self.Atspi.Role.FRAME:
                continue
            ext = frame.get_extents(self.Atspi.CoordType.SCREEN)
            if (ext.width, ext.height) != (geo['w'], geo['h']):
                continue
            found = self._documents_in(frame)
            if found:
                chosen, documents = frame, found
                break
        if chosen is None:
            raise Refuse(EXIT_REFUSED, 'ERR no-active-document: no page document in the bound window; a browser dialog may be open, so try key Escape')
        tabs = self.Atspi.Collection.get_matches(chosen, self._rule(roles=[self.Atspi.Role.PAGE_TAB]), self.Atspi.CollectionSortOrder.CANONICAL, 0, True)
        showing = [d for d in documents if d.get_state_set().contains(self.Atspi.StateType.SHOWING)]
        if len(tabs) > 1 or len(showing) > 1:
            raise Refuse(EXIT_REFUSED, 'ERR multiple-tabs: this window has more than one tab; close and relaunch')
        return chosen, (showing or documents)[0], window

    def _documents_in(self, frame):
        rule = self._rule(roles=[self.Atspi.Role.DOCUMENT_WEB])
        found = []
        for node in self.Atspi.Collection.get_matches(frame, rule, self.Atspi.CollectionSortOrder.CANONICAL, 0, True):
            uri = self.uri(node)
            if uri and self._top_document(node) and not is_browser_ui_document(uri):
                found.append(node)
        return found

    def _top_document(self, document):
        parent = document.get_parent()
        for _ in range(200):
            if parent is None:
                return True
            if parent.get_role() == self.Atspi.Role.DOCUMENT_WEB:
                return False
            parent = parent.get_parent()
        return False

    def _rule(self, roles=(), states=()):
        Atspi = self.Atspi
        return Atspi.MatchRule.new(Atspi.StateSet.new(list(states)), Atspi.CollectionMatchType.ALL, {}, Atspi.CollectionMatchType.ALL,
                                   [int(r) for r in roles], Atspi.CollectionMatchType.ANY, [], Atspi.CollectionMatchType.ALL, False)

    def uri(self, document):
        try:
            return (self.Atspi.Document.get_document_attributes(document) or {}).get('URI') or ''
        except self.GLib.Error:
            return ''

    def same(self, a, b):
        return a is not None and b is not None and getattr(a, 'path', 1) == getattr(b, 'path', 2)

    def focused(self, frame, document):
        """Chrome keeps a page element's focused state while its own interface has real focus, so several
        objects can answer at once. Browser interface wins; a document object itself is never the answer."""
        nodes = self.Atspi.Collection.get_matches(frame, self._rule(states=[self.Atspi.StateType.FOCUSED]), self.Atspi.CollectionSortOrder.CANONICAL, 0, True)
        nodes = [n for n in nodes if n.get_role() != self.Atspi.Role.DOCUMENT_WEB]
        outside = [n for n in nodes if not self.inside(n, document)]
        if outside:
            return outside[0]
        return nodes[-1] if nodes else None

    def owning_document(self, node):
        """The nearest document above this element: an iframe's own document, not the top page."""
        current = node
        for _ in range(500):
            if current is None:
                return None
            if current.get_role() == self.Atspi.Role.DOCUMENT_WEB:
                return current
            current = current.get_parent()
        return None

    def inside(self, node, ancestor):
        current = node
        for _ in range(500):
            if current is None:
                return False
            if self.same(current, ancestor):
                return True
            current = current.get_parent()
        return False

    def in_browser_dialog(self, node):
        roles = (self.Atspi.Role.DIALOG, self.Atspi.Role.ALERT, self.Atspi.Role.NOTIFICATION)
        current = node
        for _ in range(500):
            if current is None or current.get_role() == self.Atspi.Role.DOCUMENT_WEB:
                return False
            if current.get_role() in roles:
                return True
            current = current.get_parent()
        return False

    def extents(self, node):
        ext = node.get_extents(self.Atspi.CoordType.SCREEN)
        return (ext.x, ext.y, ext.width, ext.height)

    def char_count(self, node):
        try:
            return self.Atspi.Text.get_character_count(node)
        except (self.GLib.Error, TypeError):
            return None

    # -- events -----------------------------------------------------------------------------------
    def listen(self, pinned, on_event):
        """Only events about the pinned element or its own document chain stop typing: an advert
        loading in some other iframe must not."""
        def handle(event):
            source = event.source
            if self.same(source, pinned) or self.inside(pinned, source):
                on_event(event.type)
        self.listener = self.Atspi.EventListener.new(handle)
        for name in ('document:load-complete', 'document:load-start', 'object:state-changed:busy', 'object:state-changed:focused'):
            self.listener.register(name)

    def pump(self):
        context = self.GLib.MainContext.default()
        while context.pending():
            context.iteration(False)

    # -- checks before every input ----------------------------------------------------------------
    def forget_typed_if_page_changed(self):
        typed = self.target.get('typed')
        if typed:
            try:
                current = self.uri(self.frame_and_document()[1])
            except Refuse:
                return
            if current != typed.get('uri'):
                self.target.pop('typed', None)
                write_json(self.state.target_file(self.target['profile']), self.target)

    def wrapper_alive(self):
        if self.wrapper_pid and proc_start_time(self.wrapper_pid) != self.wrapper_start:
            raise Refuse(EXIT_ERROR, 'ERR driver-crash: the wrapper is gone; input stopped')

    def before_input(self, window):
        self.wrapper_alive()
        if self.backend.focused_window() != window:
            raise Refuse(EXIT_REFUSED, 'refused: focus left the target mid-typing (stopped)')

    def post_state(self, verdict, uri_before=None):
        time.sleep(0.5)
        frame, document, _ = self.frame_and_document()
        uri = self.uri(document)
        focus = self.focused(frame, document)
        print('URI %s' % escape_page(redact_uri(uri)))
        print('TITLE %s' % escape_page(document.get_name()))
        print('FOCUS %s' % (('[password field]' if self.is_masked(focus) else escape_page('%s %s' % (focus.get_role_name(), focus.get_name()))) if focus else '(none)'))
        print('URI-CHANGED %s' % ('yes' if uri_before is not None and uri != uri_before else 'no'))
        print(verdict)

    def wait_navigation(self, before):
        deadline = time.time() + 15
        while time.time() < deadline:
            self.pump()
            try:
                if self.uri(self.frame_and_document()[1]) != before:
                    return True
            except Refuse:
                pass
            time.sleep(0.25)
        return False

    # -- commands ---------------------------------------------------------------------------------
    def cmd_url(self):
        frame, document, _ = self.frame_and_document()
        print(escape_page(redact_uri(self.uri(document))))
        return EXIT_OK

    def cmd_title(self):
        print(escape_page(self.frame_and_document()[1].get_name()))
        return EXIT_OK

    def is_masked(self, node, document_uri=None):
        """One rule for every output path: a password box, or the box typesecret filled, even if a
        'show password' toggle has since made it a plain entry."""
        if node.get_role() == self.Atspi.Role.PASSWORD_TEXT:
            return True
        typed = self.target.get('typed') or {}
        if not typed:
            return False
        # A page can replace the box when a toggle reveals it, so while the record holds, every
        # editable field on this document is masked, not just the one recorded.
        return getattr(node, 'path', None) == typed.get('path') or node.get_state_set().contains(self.Atspi.StateType.EDITABLE)

    def cmd_text(self, outfile):
        path = check_outfile(self.state.home, outfile)
        sweep_outfiles(self.state.out)
        _, document, _ = self.frame_and_document()
        uri = self.uri(document)
        changed = []
        self.listener = self.Atspi.EventListener.new(lambda event: changed.append(event.type) if self.same(event.source, document) else None)
        self.listener.register('document:load-complete')
        counts = {'nodes': 0, 'bytes': 0, 'stop': None}
        deadline = time.time() + max(float(os.environ.get('XD_CMD_TIMEOUT', '60')) - 5, 1)
        fd, tmp = tempfile.mkstemp(dir=self.state.out)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as out:
                def emit(piece):
                    counts['bytes'] += len(piece.encode('utf-8', 'replace'))
                    out.write(piece)

                def walk(node, depth):
                    if counts['stop'] or depth > 400:
                        return
                    counts['nodes'] += 1
                    if counts['nodes'] % 500 == 0:
                        self.pump()
                        if changed or self.uri(document) != uri:
                            raise Refuse(EXIT_CHECK, 'ERR page-changed; read again')
                    if counts['nodes'] >= TEXT_NODE_CAP:
                        counts['stop'] = 'node limit'
                    elif counts['bytes'] >= TEXT_BYTE_CAP:
                        counts['stop'] = 'size limit'
                    elif time.time() > deadline:
                        counts['stop'] = 'time limit'
                    if counts['stop']:
                        return
                    if self.is_masked(node):
                        emit('[password field]\n')
                        return
                    text = None
                    if node.get_text_iface() is not None:
                        text = self.Atspi.Text.get_text(node, 0, -1)
                    children = [node.get_child_at_index(i) for i in range(node.get_child_count())]
                    if text is None:
                        for child in children:
                            if child is not None:
                                walk(child, depth + 1)
                        return
                    pieces = text.split('￼')
                    embedded = iter(c for c in children if c is not None)
                    emit(pieces[0])
                    for piece in pieces[1:]:
                        child = next(embedded, None)
                        if child is not None:
                            walk(child, depth + 1)
                        emit(piece)
                    emit('\n')

                walk(document, 0)
            if counts['stop']:
                os.replace(tmp, path)
                os.chmod(path, 0o600)
                print('TRUNCATED at %d nodes (%s); the rest of the document was not read' % (counts['nodes'], counts['stop']))
                return EXIT_CHECK
            os.replace(tmp, path)
            os.chmod(path, 0o600)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        print('WROTE %s' % path)
        return EXIT_OK

    def matches(self, document, name, role):
        rule = self._rule(states=[self.Atspi.StateType.SHOWING])
        nodes = self.Atspi.Collection.get_matches(document, rule, self.Atspi.CollectionSortOrder.CANONICAL, 0, True)
        wanted, role_l = name.lower(), (role or '').lower()
        hits, checked = [], 0
        candidates = [n for n in nodes if not role_l or n.get_role_name().lower() == role_l]
        for node in candidates[:FIND_CANDIDATE_CAP]:
            checked += 1
            label = node.get_name() or ''
            if wanted in label.lower():
                hits.append(node)
        return self.without_inner_text(hits), checked, len(candidates)

    def without_inner_text(self, hits):
        """A link's own text is a child with the same name and box: one thing on the page, not two."""
        kept = []
        for node in hits:
            parent = node.get_parent()
            duplicate = any(self.same(parent, other) and self.extents(other) == self.extents(node) for other in hits)
            if not duplicate:
                kept.append(node)
        return kept

    def describe(self, index, node):
        rect = self.extents(node)
        label = '[password field]' if self.is_masked(node) else (node.get_name() or '')
        visible = ''
        if not self.is_masked(node) and node.get_text_iface() is not None:
            visible = (self.Atspi.Text.get_text(node, 0, 200) or '').replace('￼', '').strip()
        mark = ' name≠text %s' % escape_page(visible) if visible and visible != label else ''
        return '%d %s %s centre %d,%d rect %d,%d,%d,%d%s' % (index, escape_page(node.get_role_name()), escape_page(label), rect[0] + rect[2] // 2, rect[1] + rect[3] // 2, rect[0], rect[1], rect[2], rect[3], mark)

    def cmd_find(self, name, role=None):
        _, document, _ = self.frame_and_document()
        hits, checked, total = self.matches(document, name, role)
        for i, node in enumerate(hits, 1):
            print(self.describe(i, node))
        if checked < total:
            print('INCOMPLETE: %d of %d candidates checked; add a role' % (checked, total))
            return EXIT_CHECK
        return EXIT_OK if hits else EXIT_REFUSED

    def hit_chain(self, document, point):
        node = self.Atspi.Component.get_accessible_at_point(document, point[0], point[1], self.Atspi.CoordType.SCREEN)
        chain = []
        for _ in range(100):
            if node is None:
                break
            chain.append(node)
            node = self.Atspi.Component.get_accessible_at_point(node, point[0], point[1], self.Atspi.CoordType.SCREEN)
            if node is not None and chain and self.same(node, chain[-1]):
                break
        return chain

    def cmd_click(self, name, role=None, index=None):
        frame, document, window = self.frame_and_document()
        uri_before = self.uri(document)
        for attempt in (1, 2):
            hits, checked, total = self.matches(document, name, role)
            if checked < total:
                raise Refuse(EXIT_REFUSED, 'ERR incomplete-search: add a role')
            if not hits:
                raise Refuse(EXIT_REFUSED, 'ERR no-match')
            if len(hits) > 1 and index is None:
                for i, node in enumerate(hits, 1):
                    print(self.describe(i, node))
                raise Refuse(EXIT_REFUSED, 'ERR ambiguous-match: give an index')
            pick = int(index) - 1 if index is not None else 0
            if pick < 0 or pick >= len(hits):
                raise Refuse(EXIT_ARG, 'ERR bad-argument: no such index')
            target = hits[pick]
            point = self.backend.to_input_point(self.extents(target), window)
            geo = self.backend.geometry(window)
            if not (geo['x'] <= point[0] < geo['x'] + geo['w'] and geo['y'] <= point[1] < geo['y'] + geo['h']):
                raise Refuse(EXIT_REFUSED, 'ERR hit-test-mismatch: the element is outside the bound window')
            self.backend.focus_window(window)
            self.backend.move(point)
            time.sleep(0.15)
            chain = self.hit_chain(document, point)
            under, at = self.backend.pointer_window()
            good = any(self.same(node, target) or self.inside(node, target) for node in chain) and under == window and at == point
            if good:
                self.before_input(window)
                self.backend.button(1, True)
                self.backend.button(1, False)
                return self.finish_input(uri_before)
            if any(self.in_browser_dialog(node) for node in chain):
                raise Refuse(EXIT_REFUSED, 'ERR browser-dialog-operator-only')
        raise Refuse(EXIT_REFUSED, 'ERR hit-test-mismatch: something else is under that point; nothing was clicked')

    def finish_input(self, uri_before):
        if os.environ.get('XD_EXPECT') == 'nav':
            moved = self.wait_navigation(uri_before)
            self.post_state('NAVIGATED' if moved else 'NO-NAVIGATION', uri_before)
            return EXIT_OK if moved else EXIT_CHECK
        self.post_state('DELIVERED', uri_before)
        return EXIT_OK

    def pin_entry(self, frame, document):
        focus = self.focused(frame, document)
        if focus is None or not self.inside(focus, document):
            raise Refuse(EXIT_REFUSED, 'ERR browser-dialog-operator-only: focus is not inside the page')
        return focus

    def type_guarded(self, chars, window, pinned, per_key=None):
        stopped = []
        self.listen(pinned, lambda kind: stopped.append(kind))
        for ch in chars:
            self.pump()
            self.before_input(window)
            state = pinned.get_state_set()
            if stopped or not state.contains(self.Atspi.StateType.FOCUSED):
                raise Stopped()
            if per_key:
                per_key()
            self.backend.type_char(ch)

    def cmd_type(self):
        text = sys.stdin.read()
        if text.endswith('\n'):
            text = text[:-1]
        if not text:
            raise Refuse(EXIT_REFUSED, 'ERR bad-argument: nothing on stdin')
        require_typable(text)
        require_fits_deadline(len(text), float(os.environ.get('XD_CMD_TIMEOUT', '60')))
        frame, document, window = self.frame_and_document()
        uri_before = self.uri(document)
        self.backend.focus_window(window)
        self.backend.reset_modifiers()
        pinned = self.pin_entry(frame, document)
        if pinned.get_role() == self.Atspi.Role.PASSWORD_TEXT:
            raise Refuse(EXIT_REFUSED, 'ERR secret-field-use-typesecret')
        if not pinned.get_state_set().contains(self.Atspi.StateType.EDITABLE):
            raise Refuse(EXIT_REFUSED, 'ERR not-an-editable-field')
        self.type_guarded(text, window, pinned)
        return self.finish_input(uri_before)

    def secret_destination_ok(self, pinned, expected_host):
        owner = self.owning_document(pinned)
        if owner is None:
            raise Refuse(EXIT_REFUSED, 'ERR host-mismatch: the box has no readable document; nothing was typed')
        check_secret_destination(self.uri(owner), expected_host)

    def cmd_typesecret(self, expected_host):
        check_secret_destination('https://%s/' % (expected_host or '').strip().lower().rstrip('.'), expected_host)
        secret = read_secret(sys.stdin.buffer)
        try:
            try:
                text = secret.decode('ascii')
            except UnicodeDecodeError:
                raise Refuse(EXIT_REFUSED, 'ERR untypable-character: the text holds a character the private display\'s US layout cannot type; nothing was typed')
            require_typable(text)
            require_fits_deadline(len(text), float(os.environ.get('XD_CMD_TIMEOUT', '60')))
            frame, document, window = self.frame_and_document()
            self.backend.focus_window(window)
            self.backend.reset_modifiers()
            pinned = self.pin_entry(frame, document)
            if pinned.get_role() != self.Atspi.Role.PASSWORD_TEXT:
                raise Refuse(EXIT_REFUSED, 'ERR not-a-password-field')
            self.secret_destination_ok(pinned, expected_host)
            # Recorded before the first key, so a stop partway still leaves the box masked.
            self.target['typed'] = {'path': getattr(pinned, 'path', None), 'uri': self.uri(document)}
            write_json(self.state.target_file(self.target['profile']), self.target)
            self.before_input(window)
            self.backend.tap('a', ctrl=True)
            self.backend.tap('Delete')
            for _ in range(20):
                if self.char_count(pinned) == 0:
                    break
                time.sleep(0.05)
            else:
                raise Refuse(EXIT_REFUSED, 'ERR field-not-empty: the box could not be cleared; nothing was typed')
            self.type_guarded(text, window, pinned, per_key=lambda: self.secret_destination_ok(pinned, expected_host))
            time.sleep(0.2)
            self.pump()
            self.secret_destination_ok(pinned, expected_host)
            if self.char_count(pinned) != len(text) or not pinned.get_state_set().contains(self.Atspi.StateType.FOCUSED):
                raise Stopped('refused: the value did not arrive in full')
            print('DELIVERED')
            return EXIT_OK
        finally:
            wipe(secret)
            text = None

    def cmd_key(self, name):
        if name not in NAMED_KEYS:
            raise Refuse(EXIT_ARG, 'ERR bad-argument: that key is not on the list')
        if name == 'Escape':
            # Can only cancel, so it is allowed with a pop-up open or several windows showing.
            windows = self.backend.windows_of(self.target['pid'])
            if not windows:
                raise Refuse(EXIT_REFUSED, 'ERR no-target: the bound window is gone')
            self.backend.focus_window(windows[-1])
            self.wrapper_alive()
            self.backend.tap('Escape')
            print('DELIVERED')
            return EXIT_OK
        frame, document, window = self.frame_and_document()
        uri_before = self.uri(document)
        self.backend.focus_window(window)
        focus = self.focused(frame, document)
        if focus is None or not self.inside(focus, document):
            raise Refuse(EXIT_REFUSED, 'ERR browser-dialog-operator-only')
        self.before_input(window)
        self.backend.tap(name)
        return self.finish_input(uri_before)

    def cmd_nav(self, url):
        check_url(url)
        require_typable(url)
        frame, document, window = self.frame_and_document()
        before = self.uri(document)
        self.backend.focus_window(window)
        self.backend.reset_modifiers()
        self.before_input(window)
        self.backend.tap('l', ctrl=True)
        time.sleep(0.15)
        omnibox = self.focused(frame, document)
        if omnibox is None or self.inside(omnibox, document) or omnibox.get_role() not in (self.Atspi.Role.ENTRY, self.Atspi.Role.TEXT):
            raise Refuse(EXIT_REFUSED, 'ERR browser-dialog-operator-only: the address bar did not take focus; nothing was typed')
        self.type_guarded(url, window, omnibox)
        self.backend.tap('Delete')
        self.backend.tap('Return')
        loaded = []
        self.listener = self.Atspi.EventListener.new(lambda event: loaded.append(event.type))
        self.listener.register('document:load-complete')
        deadline = time.time() + 15
        while time.time() < deadline and not loaded:
            self.pump()
            time.sleep(0.1)
        final = self.uri(self.frame_and_document()[1])
        print('REQUESTED %s' % redact_uri(url))
        print('FINAL %s' % escape_page(redact_uri(final)))
        if not loaded and final == before:
            print('NAV-TIMEOUT')
            return EXIT_CHECK
        if not loaded:
            print('SAME-DOCUMENT')
        if uri_host(final) != uri_host(url):
            print('nav-landed-elsewhere')
            return EXIT_CHECK
        return EXIT_OK


class Stopped(Exception):
    """Typing stopped partway: some keys may have arrived, so the latch stays and nothing is echoed."""

    def __init__(self, message='refused: focus left the target mid-typing (stopped)'):
        super().__init__(message)
        self.message = message


# ---------------------------------------------------------------------------------------------------
# Binding, launch, close, and the entry point.
# ---------------------------------------------------------------------------------------------------
def chrome_binary():
    """The binary itself, never Google's wrapper script, so the spawned pid is the browser process."""
    binary = '/opt/google/chrome/chrome'
    if not os.access(binary, os.X_OK):
        raise Refuse(EXIT_REFUSED, 'ERR missing-dependency: google-chrome')
    return binary


def is_browser_cmdline(raw, profile_dir):
    """Chrome rewrites its process title, so /proc/<pid>/cmdline may be one space-joined string, not
    NUL-separated arguments. Both forms: that exact --user-data-dir, and no --type= argument."""
    wanted = re.escape(('--user-data-dir=%s' % profile_dir).encode())
    return re.search(b'(^|[\\0 ])' + wanted + b'($|[\\0 ])', raw) is not None and re.search(b'(^|[\\0 ])--type=', raw) is None


def browser_pids(profile_dir):
    """Browser processes on this profile."""
    found = []
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        try:
            with open('/proc/%s/cmdline' % entry, 'rb') as handle:
                raw = handle.read()
        except OSError:
            continue
        if is_browser_cmdline(raw, profile_dir):
            found.append(int(entry))
    return found


def seed_profile_prefs(profile_dir):
    """Chrome is not running here. No save-password bubble, and nothing stored by Chrome."""
    path = os.path.join(profile_dir, 'Default', 'Preferences')
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    prefs = read_json(path) or {}
    prefs['credentials_enable_service'] = False
    prefs.setdefault('profile', {})['password_manager_enabled'] = False
    write_json(path, prefs)


def load_binding(state, profile_id):
    if not profile_id or not PROFILE_ID.match(profile_id):
        raise Refuse(EXIT_REFUSED, 'ERR no-target: set XD_PROFILE to a launched profile')
    target = read_json(state.target_file(profile_id))
    if not target or proc_start_time(target['pid']) != target['start'] or target['pid'] not in browser_pids(target['dir']):
        latch = os.environ.get('XD_LATCH_FILE')
        if latch and os.path.exists(latch):
            os.unlink(latch)
            print('latch cleared: bound Chrome gone')
        raise Refuse(EXIT_REFUSED, 'ERR no-target: no live Chrome is bound to that profile')
    return target


def cmd_launch(state, args):
    new = '--new' in args
    args = [a for a in args if a != '--new']
    if len(args) != 2:
        raise Refuse(EXIT_ARG, 'ERR bad-argument: launch <profileId> <url> [--new]')
    profile_id, url = args
    check_url(url)
    extra = check_extra_flags(os.environ.get('XD_CHROME_FLAGS'))
    profile_dir = resolve_profile(state.home, profile_id, must_exist=not new)
    if new:
        if os.path.exists(profile_dir):
            raise Refuse(EXIT_REFUSED, 'ERR profile-exists: that profile is already there; drop --new')
        os.makedirs(profile_dir, mode=0o700)
    elif stat.S_IMODE(os.stat(profile_dir).st_mode) & 0o077:
        raise Refuse(EXIT_REFUSED, 'ERR profile-permissions: the profile folder must be 0700')
    binary = chrome_binary()
    existing = read_json(state.target_file(profile_id))
    running = browser_pids(profile_dir)
    if existing and existing.get('pid') in running and proc_start_time(existing['pid']) == existing.get('start'):
        print('ALREADY-RUNNING')
        return EXIT_OK
    if running:
        raise Refuse(EXIT_REFUSED, 'ERR profile-in-use: another Chrome has this profile; it is never driven or closed from here')
    seed_profile_prefs(profile_dir)
    record = check_stack(state) or start_stack(state)
    env = _display_env(state, record)
    os.environ.update(env)
    chrome_env = minimal_env(dict(env, ACCESSIBILITY_ENABLED='1'))
    chrome_env.update({k: v for k, v in os.environ.items() if k.startswith('LC_')})
    # /opt/google/chrome/chrome is the browser process itself, so it is bound the moment it exists:
    # a wrapper killed from here on leaves a Chrome that close can still find.
    proc = spawn(chrome_args(binary, profile_dir, url, extra), chrome_env)
    pid = proc.pid
    target = {'profile': profile_id, 'dir': profile_dir, 'pid': pid, 'start': proc_start_time(pid)}
    write_json(state.target_file(profile_id), target)
    backend = X11Backend()
    deadline = time.time() + 15
    window = None
    while time.time() < deadline and not window and proc.poll() is None:
        windows = backend.windows_of(pid)
        window = windows[0] if windows else None
        time.sleep(0.1)
    if not window:
        signal_recorded([{'pid': pid, 'start': target['start']}], proc_start_time, os.kill)
        after_close(state, profile_id)
        raise Refuse(EXIT_REFUSED, 'ERR no-atspi: Chrome started no window, so it was stopped')
    target['window'] = window
    write_json(state.target_file(profile_id), target)
    driver = Driver(state, backend, target, None)
    deadline = time.time() + 10
    while True:
        try:
            driver.app()
            break
        except Refuse:
            if time.time() > deadline:
                signal_recorded([{'pid': pid, 'start': target['start']}], proc_start_time, os.kill)
                after_close(state, profile_id)
                raise Refuse(EXIT_REFUSED, 'ERR no-atspi: Chrome did not reach the accessibility bus, so it was stopped')
            time.sleep(0.1)
    ledger(state, 'launch', profile_dir)
    print('LAUNCHED display :%d profile %s' % (record['display'], profile_id))
    print('linger: %s' % linger_state())
    print('note: this profile\'s cookies are protected by file permissions only')
    return EXIT_OK


def linger_state():
    try:
        out = subprocess.run(['loginctl', 'show-user', str(os.getuid()), '--property=Linger'], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return 'unknown'
    return {'Linger=yes': 'yes', 'Linger=no': 'no'}.get(out.strip(), 'unknown')


def ledger(state, action, profile_dir):
    """The browser ledger is a record: a failure here never stops the caller."""
    script = os.path.join(state.home, '.instar', 'scripts', 'browser', 'chrome-ledger.sh')
    try:
        subprocess.run([script, action, profile_dir, 'xdrive'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    except (OSError, subprocess.SubprocessError):
        pass


def note_first_success(state, target, command):
    """A DELIVERED input followed by a clean read on the same binding, once per agent."""
    path = os.path.join(state.home, '.instar', 'logs', 'normal-chrome-browser-first-success.json')
    if command in INPUT_COMMANDS:
        target['delivered'] = True
        write_json(state.target_file(target['profile']), target)
    elif command in READ_COMMANDS and target.get('delivered') and not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        write_json(path, {'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'label': 'delivered + read', 'via': 'xdrive'})


def after_close(state, profile_id):
    path = state.target_file(profile_id)
    target = read_json(path)
    if target:
        ledger(state, 'complete', target['dir'])
    if os.path.exists(path):
        os.unlink(path)
    if not bound_targets(state):
        stop_stack(state, read_json(state.record))


def cmd_close(state, target, force):
    pid, start = target['pid'], target['start']
    if force:
        signal_recorded([{'pid': pid, 'start': start}], proc_start_time, os.kill)
        after_close(state, target['profile'])
        print('CLOSED (forced): unsaved input in that window is gone')
        return EXIT_OK
    backend = X11Backend()
    windows = backend.windows_of(pid)
    if windows:
        backend.focus_window(windows[0])
        backend.tap('w', shift=True, ctrl=True)
    deadline = time.time() + 10
    while time.time() < deadline and proc_start_time(pid) == start:
        time.sleep(0.1)
    if proc_start_time(pid) == start:
        raise Refuse(EXIT_REFUSED, 'ERR close-blocked: a window is still open (a dialog, unsaved input or a download); nothing was killed; close --force ends it')
    after_close(state, target['profile'])
    print('CLOSED')
    return EXIT_OK


READ_COMMANDS = ('url', 'title', 'text', 'find')
INPUT_COMMANDS = ('click', 'type', 'typesecret', 'key', 'nav')


def dispatch(driver, command, args):
    if command == 'url':
        return driver.cmd_url()
    if command == 'title':
        return driver.cmd_title()
    if command == 'text' and len(args) == 1:
        return driver.cmd_text(args[0])
    if command == 'find' and 1 <= len(args) <= 2:
        return driver.cmd_find(*args)
    if command == 'click' and 1 <= len(args) <= 3:
        return driver.cmd_click(*args)
    if command == 'type' and not args:
        return driver.cmd_type()
    if command == 'typesecret' and len(args) == 1:
        return driver.cmd_typesecret(args[0])
    if command == 'key' and len(args) == 1:
        return driver.cmd_key(args[0])
    if command == 'nav' and len(args) == 1:
        return driver.cmd_nav(args[0])
    raise Refuse(EXIT_ARG, 'ERR bad-argument: unknown command or wrong arguments')


def run(argv):
    home = os.environ.get('XD_HOME')
    if not home or not argv:
        raise Refuse(EXIT_ARG, 'ERR bad-argument: run this through xdrive.sh')
    state = State(home)
    command, args = argv[0], argv[1:]
    if command == 'launch':
        return cmd_launch(state, args)
    profile_id = os.environ.get('XD_PROFILE', '')
    if command == 'close':
        # Close needs the binding and, unless forced, the X server. It never needs the accessibility
        # side, so it still works on an unhealthy stack and with several windows or tabs.
        record = read_json(state.record)
        if record:
            os.environ.update(_display_env(state, record))
        return cmd_close(state, load_binding(state, profile_id), '--force' in args)
    record = check_stack(state)
    if record is None:
        raise Refuse(EXIT_REFUSED, 'ERR no-target: no agent display is running; use launch')
    os.environ.update(_display_env(state, record))
    target = load_binding(state, profile_id)
    backend = X11Backend()
    if os.environ.get('XD_LATCH_SET') == '1':
        backend.release_everything()
    driver = Driver(state, backend, target, int(os.environ.get('XD_WRAPPER_PID', '0')))
    driver.forget_typed_if_page_changed()
    try:
        code = dispatch(driver, command, args)
        if code == EXIT_OK:
            note_first_success(state, target, command)
        return code
    finally:
        backend.release_all()


def mark_partial():
    """Some input went out before this stop, so the wrapper must keep the latch."""
    partial = os.environ.get('XD_PARTIAL_FILE')
    if partial and INPUT_SENT[0]:
        with open(partial, 'w'):
            pass


def main():
    # A crash must not write this process's memory, which can hold a password, to a core file.
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(EXIT_ERROR))
    try:
        return run(sys.argv[1:])
    except Refuse as refusal:
        mark_partial()
        print(refusal.message)
        return refusal.code
    except Stopped as stop:
        INPUT_SENT[0] = True
        mark_partial()
        print(stop.message)
        return EXIT_REFUSED
    except Exception as err:
        # The type only: a message could carry page text or a value.
        print('ERR driver-crash: %s; read the page before any more input' % type(err).__name__)
        return EXIT_ERROR


if __name__ == '__main__':
    sys.exit(main())
