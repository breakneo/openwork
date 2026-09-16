import errno
import json
import os
import pty
import select
import signal
import sys
import time

steps = json.loads(sys.argv[1])
pid, master = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[2], sys.argv[2:], os.environ)

transcript = bytearray()
step = 0
cursor = 0
status = None
timed_out = False
deadline = time.monotonic() + 90
try:
    while True:
        if time.monotonic() > deadline:
            timed_out = True
            os.kill(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
            break
        readable, _, _ = select.select([master], [], [], 0.1)
        if readable:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            if not chunk:
                _, status = os.waitpid(pid, 0)
                break
            transcript.extend(chunk)
            if step < len(steps):
                expected = steps[step]["prompt"].encode()
                found = transcript.find(expected, cursor)
                if found >= 0:
                    cursor = found + len(expected)
                    os.write(master, steps[step]["reply"].encode())
                    step += 1
finally:
    if status is None:
        os.kill(pid, signal.SIGKILL)
        _, status = os.waitpid(pid, 0)
    os.close(master)

print(json.dumps({"code": os.waitstatus_to_exitcode(status), "stdout": transcript.decode(errors="replace"), "stderr": "", "timedOut": timed_out, "answeredPrompts": step, "pty": True}))
