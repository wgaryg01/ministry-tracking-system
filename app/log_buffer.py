import sys
from collections import deque
from datetime import datetime

# Shared ring buffer of the last 50 lines written anywhere via print()
# or the logging module. Captured at the stdout level (rather than
# only via a logging.Handler) because this codebase mixes plain
# print() calls with logging in a few places, and this way nothing
# is missed regardless of which one produced a given line.
_recent_lines: deque = deque(maxlen=50)


class _TeeStdout:
    """Wraps the real stdout — everything still prints normally, but
    each line also lands in the ring buffer."""

    def __init__(self, real_stdout):
        self._real = real_stdout

    def write(self, data):
        self._real.write(data)
        for line in data.splitlines():
            if line.strip():
                _recent_lines.append(f"{datetime.utcnow().isoformat()} {line}")

    def flush(self):
        self._real.flush()

    def __getattr__(self, name):
        return getattr(self._real, name)


def install_log_capture():
    if not isinstance(sys.stdout, _TeeStdout):
        sys.stdout = _TeeStdout(sys.stdout)
    if not isinstance(sys.stderr, _TeeStdout):
        sys.stderr = _TeeStdout(sys.stderr)


def get_recent_log_lines() -> list[str]:
    return list(_recent_lines)
