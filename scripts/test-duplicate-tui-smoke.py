#!/usr/bin/env python3
import atexit
import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path

if len(sys.argv) < 3:
    raise SystemExit('usage: test-duplicate-tui-smoke.py PACKAGE TRANSCRIPT')

package = Path(sys.argv[1]).resolve()
transcript = Path(sys.argv[2]).resolve()
root = Path(tempfile.mkdtemp(prefix='pi-experiences-duplicate-tui-'))
state = root / 'state'
work = root / 'work'
seed_package = root / 'seed-package'
work.mkdir(parents=True)
shutil.copytree(package, seed_package, ignore=shutil.ignore_patterns('.git', 'node_modules'))
atexit.register(lambda: shutil.rmtree(root, ignore_errors=True))

module = lambda relative: json.dumps((seed_package / relative).as_uri())
seed = f'''
import {{ ensurePrivateRoot }} from {module('extensions/agent-experience/src/storage/private-root.ts')};
import {{ initExperienceStorage, insertStorageRecord }} from {module('extensions/agent-experience/src/storage/sqlite.ts')};
import {{ upsertHabitDuplicate }} from {module('extensions/agent-experience/src/semantic/storage.ts')};
const root = {json.dumps(str(state))};
await ensurePrivateRoot(root);
const storage = await initExperienceStorage(root, {{ allowInit: true, userId: 'owner' }});
const base = {{ schema_version: 2, record_kind: 'candidate_habit_v1', polarity: 1, confidence_bp: 9000, source_refs: [], source_dates: [], injectable: false }};
insertStorageRecord(storage.db, 'habits', {{ id: 'tui-habit-a', userId: 'owner', data: {{ ...base, status: 'active', active: true, condition: 'When preparing nontrivial code changes or package releases', behavior: 'Run required checks and independent review before declaring the release ready.' }}, now: '2026-07-10T08:00:00.000Z' }});
insertStorageRecord(storage.db, 'habits', {{ id: 'tui-habit-b', userId: 'owner', data: {{ ...base, status: 'candidate', review_status: 'duplicate_resolution', active: false, condition: 'Before calling substantial implementation work complete', behavior: 'Complete validation and external critique before making a completion claim.', approved_identity: {{ candidate_id: 'tui-habit-b', condition: 'before calling substantial implementation work complete', behavior: 'complete validation and external critique before making a completion claim.', polarity: 1, approved_at: '2026-07-10T08:01:30.000Z' }} }}, now: '2026-07-10T08:01:00.000Z' }});
upsertHabitDuplicate(storage.db, {{ userId: 'owner', habitId: 'tui-habit-a', otherHabitId: 'tui-habit-b', canonicalHabitId: 'tui-habit-a', duplicateHabitId: 'tui-habit-b', similarityBp: 8048, thresholdBp: 4000, provider: 'private-fixture', model: 'private-fixture', dimensions: 384, decision: 'pending', data: {{ action: 'tui_smoke' }}, now: '2026-07-10T08:02:00.000Z' }});
storage.db.close();
'''
subprocess.run(['node', '--experimental-strip-types', '--input-type=module', '-e', seed], check=True)

raw = bytearray()
csi = re.compile(rb'\x1b\[[0-?]*[ -/]*[@-~]')
osc = re.compile(rb'\x1b\][^\x07]*(?:\x07|\x1b\\)')
def clean(data):
    return csi.sub(b'', osc.sub(b'', data)).replace(b'\r', b'\n').decode('utf-8', 'replace')
def text(start=0):
    return clean(bytes(raw[start:]))
def drain(fd, seconds=.15):
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], max(0, end - time.time()))
        if not ready:
            break
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        raw.extend(chunk)
def wait(fd, pattern, timeout=15, start=0):
    rx = re.compile(pattern, re.I | re.S)
    end = time.time() + timeout
    while time.time() < end:
        drain(fd, .2)
        if rx.search(text(start)):
            return
    raise AssertionError(f'TUI did not show /{pattern}/ within {timeout}s')
def send(fd, data, pause=.2):
    os.write(fd, data)
    drain(fd, pause)
def down(fd, count):
    for _ in range(count):
        send(fd, b'\x1b[B', .05)
def enter(fd):
    send(fd, b'\r', .35)
def escape(fd):
    send(fd, b'\x1b', .35)

pid, fd = pty.fork()
if pid == 0:
    env = {**os.environ, 'AX_STATE_ROOT': str(state), 'AX_USER_ID': 'owner', 'TERM': 'xterm-256color'}
    os.chdir(work)
    os.execvpe('pi', ['pi', '--no-extensions', '--no-skills', '-e', str(package)], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 46, 120, 0, 0))
try:
    wait(fd, r'\$0\.000|gpt-', timeout=20)
    drain(fd, .5)
    mark = len(raw)
    send(fd, b'/experience setup\r', .5)
    wait(fd, r'Agent Experience setup', start=mark)
    down(fd, 4)
    mark = len(raw)
    enter(fd)
    wait(fd, r'Resolve duplicate habits.*1 item', start=mark)
    mark = len(raw)
    enter(fd)
    wait(fd, r'Possible duplicate habits', start=mark)
    comparison = text(mark)
    for expected in [
        'Habit A:', 'Status: approved — active',
        'When preparing nontrivial code changes',
        'Habit B:', 'Status: approved — waiting for duplicate resolution',
        'Before calling substantial implementation work complete',
        'Same habit', 'keep Habit A wording', 'hide Habit B',
        'Use Habit B wording', 'Different habits', 'keep both',
    ]:
        assert expected in comparison, f'missing duplicate comparison text: {expected}'
    assert 'Habit A:ssible duplicate' not in comparison
    assert not re.search(r'tui-habit-|8048|private-fixture|checksum|similarity_bp', comparison, re.I)
    mark = len(raw)
    enter(fd)
    wait(fd, r'Confirm duplicate resolution', start=mark)
    confirmation = text(mark)
    for expected in ['Will keep — Habit A', 'Will archive/hide — Habit B', 'Evidence from both will be retained under Habit A', 'Back — keep both unchanged', 'Confirm this resolution']:
        assert expected in confirmation, f'missing duplicate confirmation text: {expected}'
    back_mark = len(raw)
    enter(fd)  # Safe default is Back.
    wait(fd, r'Possible duplicate habits', start=back_mark)
    escape(fd)
    drain(fd, .4)
    escape(fd)
    drain(fd, .4)
    escape(fd)
    send(fd, b'\x03', .3)
    send(fd, b'\x03', .3)
    drain(fd, .8)
finally:
    transcript.parent.mkdir(parents=True, exist_ok=True)
    transcript.write_bytes(bytes(raw))
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass

verify = f'''
import {{ openExistingExperienceStorage }} from {module('extensions/agent-experience/src/storage/sqlite.ts')};
import {{ listHabitDuplicates }} from {module('extensions/agent-experience/src/semantic/storage.ts')};
const storage = await openExistingExperienceStorage({json.dumps(str(state))}, {{ userId: 'owner' }});
const pending = listHabitDuplicates(storage.db, {{ userId: 'owner', decision: 'pending' }});
const statuses = Object.fromEntries(storage.db.prepare("SELECT id, status FROM habits WHERE user_id='owner' ORDER BY id").all().map((row) => [row.id, row.status]));
storage.db.close();
if (pending.length !== 1 || statuses['tui-habit-a'] !== 'active' || statuses['tui-habit-b'] !== 'candidate') throw new Error(`confirmation cancellation changed state: ${{JSON.stringify({{pending: pending.length, statuses}})}}`);
'''
subprocess.run(['node', '--experimental-strip-types', '--input-type=module', '-e', verify], check=True)
shutil.rmtree(root, ignore_errors=True)
print(f'duplicate Pi TUI smoke passed; transcript={transcript}')
