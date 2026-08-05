#!/usr/bin/env python3
import fcntl, os, pty, re, select, shlex, signal, struct, subprocess, sys, termios, time
from pathlib import Path

if len(sys.argv) != 3:
    raise SystemExit('usage: test-advisor-tui-smoke.py INSTALLED_PACKAGE TRANSCRIPT')
package = Path(sys.argv[1]).resolve()
transcript = Path(sys.argv[2]).resolve()
state_text = os.environ.get('AX_STATE_ROOT', '').strip()
if not state_text:
    raise SystemExit('AX_STATE_ROOT must name the isolated verifier state root')
state = Path(state_text).resolve()
isolation_root = state.parent
driver = (package / 'scripts/fixtures/advisor-tui-driver.ts').resolve()
pi_bin = (package.parent / '.bin/pi').resolve()
agent_dir = Path(os.environ.get('PI_CODING_AGENT_DIR', '')).resolve()
session_dir = Path(os.environ.get('PI_CODING_AGENT_SESSION_DIR', '')).resolve()
def confined(path):
    return os.path.commonpath([str(path), str(isolation_root)]) == str(isolation_root)
for name, path in [('package', package), ('driver', driver), ('Pi binary', pi_bin), ('Pi agent directory', agent_dir), ('Pi session directory', session_dir), ('transcript', transcript)]:
    if not confined(path):
        raise SystemExit(f'{name} must stay under the isolated verifier root: {path}')
for required in (package / 'package.json', driver, pi_bin):
    if not required.exists():
        raise SystemExit(f'missing installed smoke dependency: {required}')

artifacts = transcript.parent / f'{transcript.stem}-artifacts'
artifacts.mkdir(parents=True, exist_ok=True)
transcript.write_bytes(b'')
csi = re.compile(rb'\x1b\[[0-?]*[ -/]*[@-~]')
osc = re.compile(rb'\x1b\][^\x07]*(?:\x07|\x1b\\)')
headings = [
    '◇ Experience · habit violation · concern',
    '◇ Experience · habit violation · blocker',
]
commands = ['habit-concern', 'habit-blocker']
condition = 'When publishing an installed package from a clean branch'
behavior = 'Verify the freshly packed artifact in an isolated Pi session before release'
forbidden = re.compile(r'private-smoke|h-private|schema_version|eventFingerprint|habit[_-]?id|\balias\b|checksum|lawHash|\bscore\b|session\.jsonl|raw primary|raw user|<advisory|guidance=|__advisor|model output|transcript excerpt|[cdf]{48,}', re.I)
artifact_paths = {}


def clean(data):
    return csi.sub(b'', osc.sub(b'', data)).replace(b'\r', b'\n').decode('utf-8', 'replace')


def squash(text):
    return re.sub(r'\s+', ' ', text).strip()


def drain(fd, raw, seconds=.15):
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


def wait(fd, raw, pattern, timeout=12, start=0):
    rx = re.compile(pattern, re.I | re.S)
    end = time.time() + timeout
    while time.time() < end:
        drain(fd, raw, .2)
        if rx.search(clean(bytes(raw[start:]))):
            drain(fd, raw, .3)
            return
    raise AssertionError(f'TUI did not show /{pattern}/ within {timeout}s')


def send(fd, raw, data, pause=.2):
    os.write(fd, data)
    drain(fd, raw, pause)


def resize(fd, rows, cols, raw):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    drain(fd, raw, .5)


def capture(socket, session, name):
    screen = subprocess.run(
        ['tmux', '-L', socket, 'capture-pane', '-p', '-t', session],
        check=True, capture_output=True, text=True,
    ).stdout
    path = artifacts / f'{name}.txt'
    path.write_text(screen, encoding='utf-8')
    artifact_paths[name] = str(path)
    return screen


def card_lines(screen, title, next_title=None):
    lines = screen.splitlines()
    start = next(i for i, line in enumerate(lines) if title in line)
    if next_title is None:
        end = next((i for i in range(start + 1, len(lines)) if lines[i].lstrip().startswith('>')), len(lines))
    else:
        end = next(i for i in range(start + 1, len(lines)) if next_title in lines[i])
    return [line for line in lines[start:end] if line.strip()]


def assert_cards(screen, expanded, cols):
    normalized = squash(screen)
    for heading in headings:
        assert screen.count(heading) == 1, f'expected exactly one card for {heading!r}'
    assert normalized.count(behavior) >= len(headings), 'approved habit action wording lost while wrapping'
    assert all(len(line) <= cols for line in screen.splitlines()), f'card screen overflowed {cols} columns'
    assert not forbidden.search(screen), 'Advisor card leaked fixture provenance or private state'
    if expanded:
        assert f'When: {condition}' in normalized, 'expanded habit card lost exact When wording'
        assert f'Do: {behavior}' in normalized, 'expanded habit card lost exact Do wording'
        assert f'Next step: {behavior}' in normalized, 'habit authority must render its exact next step'
    else:
        assert f'When: {condition}' not in normalized and f'Do: {behavior}' not in normalized, 'habit card must start collapsed'
        assert 'Next step:' not in normalized, 'collapsed cards must not expose expanded authority rows'


def run_case(label, rows, cols):
    raw = bytearray()
    socket = f'pi-experiences-advisor-{label}-{os.getpid()}'
    session = 'smoke'
    work = isolation_root / f'advisor-tui-work-{label}'
    work.mkdir(parents=True, exist_ok=True)
    pid, fd = pty.fork()
    if pid == 0:
        allowed = ('PATH','HOME','USER','LOGNAME','SHELL','LANG','LC_ALL','TZ','TERM','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME','PI_CODING_AGENT_DIR','PI_CODING_AGENT_SESSION_DIR','PI_OFFLINE','PI_TELEMETRY','AX_STATE_ROOT','AX_VERIFY_TEMP_ROOT','npm_config_cache')
        env = {name: os.environ[name] for name in allowed if name in os.environ}
        env['TERM'] = 'xterm-256color'
        command = f'exec {shlex.quote(str(pi_bin))} --session-dir {shlex.quote(str(session_dir))} --offline --no-context-files --no-prompt-templates --no-themes --no-approve --no-extensions --no-skills -e {shlex.quote(str(package))} -e {shlex.quote(str(driver))}'
        os.chdir(work)
        os.execve('/usr/bin/tmux', ['tmux', '-L', socket, 'new-session', '-s', session, command], env)
    resize(fd, rows, cols, raw)
    try:
        wait(fd, raw, r'0\.0%/', timeout=15)
        for expected_count, (command, heading) in enumerate(zip(commands, headings), 1):
            mark = len(raw)
            send(fd, raw, f'/advisor-smoke {command}\r'.encode(), .35)
            wait(fd, raw, re.escape(heading), start=mark)
            current = capture(socket, session, f'{label}-after-{command}')
            count = sum(current.count(candidate) for candidate in headings)
            assert count == expected_count, f'{command} emitted {count - expected_count + 1} cards; expected one card per update'
        collapsed = capture(socket, session, f'{label}-collapsed')
        assert_cards(collapsed, False, cols)
        mark = len(raw)
        send(fd, raw, b'\x0f', .4)  # app.tools.expand (Ctrl+O)
        wait(fd, raw, r'When:\s+When publishing an installed package', start=mark)
        expanded = capture(socket, session, f'{label}-expanded')
        assert_cards(expanded, True, cols)
        send(fd, raw, b'\x03', .2)
        send(fd, raw, b'\x03', .2)
        drain(fd, raw, .5)
        return collapsed, expanded, bytes(raw)
    finally:
        raw_path = artifacts / f'{label}-raw-transcript.bin'
        raw_path.write_bytes(bytes(raw))
        artifact_paths[f'{label}-raw-transcript'] = str(raw_path)
        with transcript.open('ab') as stream:
            stream.write(f'=== {label} ===\n'.encode())
            stream.write(bytes(raw))
            stream.write(b'\n')
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        subprocess.run(['tmux', '-L', socket, 'kill-server'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


wide_collapsed, wide_expanded, wide_raw = run_case('wide', 42, 120)
narrow_collapsed, narrow_expanded, narrow_raw = run_case('narrow', 42, 68)
assert len(card_lines(narrow_collapsed, headings[0], headings[1])) > len(card_lines(wide_collapsed, headings[0], headings[1])), 'narrow concern card did not wrap more than wide card'
assert len(card_lines(narrow_expanded, headings[1])) > len(card_lines(wide_expanded, headings[1])), 'narrow blocker card did not wrap more than wide card'
assert not forbidden.search(clean(wide_raw + narrow_raw)), 'PTY transcript leaked private Advisor fixture fields'
assert transcript.stat().st_size > 0, 'Advisor PTY transcript must be persisted before success'
print(f'Advisor Pi TUI smoke passed; transcript={transcript}; artifacts=' + ';'.join(f'{name}={path}' for name, path in artifact_paths.items()))
