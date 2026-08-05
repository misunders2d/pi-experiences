#!/usr/bin/env python3
import fcntl, os, pty, re, select, shlex, shutil, signal, struct, subprocess, sys, termios, time
from pathlib import Path
if len(sys.argv)<3: raise SystemExit('usage: test-installed-tui-smoke.py INSTALLED_PACKAGE TRANSCRIPT')
package_path=Path(sys.argv[1]).resolve(); package=str(package_path); transcript=Path(sys.argv[2]).resolve()
state_text=os.environ.get('AX_STATE_ROOT','').strip()
if not state_text: raise SystemExit('AX_STATE_ROOT must name the isolated verifier state root')
state=Path(state_text).resolve(); isolation_root=state.parent
agent_dir=Path(os.environ.get('PI_CODING_AGENT_DIR','')).resolve()
session_dir=Path(os.environ.get('PI_CODING_AGENT_SESSION_DIR','')).resolve()
pi_bin=(package_path.parent/'.bin/pi').resolve()
def confined(path): return os.path.commonpath([str(path),str(isolation_root)])==str(isolation_root)
for name,path in [('package',package_path),('Pi binary',pi_bin),('Pi agent directory',agent_dir),('Pi session directory',session_dir),('transcript',transcript)]:
    if not confined(path): raise SystemExit(f'{name} must stay under the isolated verifier root: {path}')
artifacts=transcript.parent/f'{transcript.stem}-artifacts'; artifacts.mkdir(parents=True,exist_ok=True)
shutil.rmtree(state,ignore_errors=True); state.mkdir(parents=True,exist_ok=True)
work=isolation_root/'pi-experiences-0.1.49-tui-work'; work.mkdir(parents=True,exist_ok=True)
raw=bytearray(); csi=re.compile(rb'\x1b\[[0-?]*[ -/]*[@-~]'); osc=re.compile(rb'\x1b\][^\x07]*(?:\x07|\x1b\\)')
artifact_paths={}
tmux_socket=f'pi-experiences-tui-{os.getpid()}'; tmux_session='smoke'
def clean(data): return csi.sub(b'',osc.sub(b'',data)).replace(b'\r',b'\n').decode('utf-8','replace')
def text(start=0): return clean(bytes(raw[start:]))
def drain(fd,seconds=.15):
    end=time.time()+seconds
    while time.time()<end:
        ready,_,_=select.select([fd],[],[],max(0,end-time.time()))
        if not ready: break
        try: chunk=os.read(fd,65536)
        except OSError: break
        if not chunk: break
        raw.extend(chunk)
def wait(fd,pattern,timeout=12,start=0):
    rx=re.compile(pattern,re.I|re.S); end=time.time()+timeout
    while time.time()<end:
        drain(fd,.2)
        if rx.search(text(start)): drain(fd,.35); return
    screen=subprocess.run(['tmux','-L',tmux_socket,'capture-pane','-p','-t',tmux_session],capture_output=True,text=True).stdout
    raise AssertionError(f'TUI did not show /{pattern}/ within {timeout}s; current screen:\n{screen}')
def send(fd,data,pause=.18): os.write(fd,data); drain(fd,pause)
def down(fd,count):
    for _ in range(count): send(fd,b'\x1b[B',.05)
def enter(fd): send(fd,b'\r',.3)
def escape(fd): send(fd,b'\x1b',.3)
def resize(fd,rows,cols): fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0)); drain(fd,.5)
def capture(name,start=0,required=()):
    path=artifacts/f'{name}.txt'
    screen=subprocess.run(['tmux','-L',tmux_socket,'capture-pane','-p','-t',tmux_session],check=True,capture_output=True,text=True).stdout
    positions=[screen.index(label) for label in required]
    assert positions==sorted(positions), f'{name} terminal screen is missing or reorders required rows'
    path.write_text(screen,encoding='utf-8'); artifact_paths[name]=str(path)
    return screen
def open_setup(fd):
    mark=len(raw); send(fd,b'/experience setup\r',.5); wait(fd,r'Agent Experience setup',start=mark); return mark
def back_home(fd):
    mark=len(raw); escape(fd); wait(fd,r'Agent Experience setup',start=mark); return mark
def open_panel(fd,index,pattern):
    down(fd,index); mark=len(raw); enter(fd); wait(fd,pattern,start=mark); return mark
pid,fd=pty.fork()
if pid==0:
    allowed=('PATH','HOME','USER','LOGNAME','SHELL','LANG','LC_ALL','TZ','TERM','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME','PI_CODING_AGENT_DIR','PI_CODING_AGENT_SESSION_DIR','PI_OFFLINE','PI_TELEMETRY','AX_STATE_ROOT','AX_VERIFY_TEMP_ROOT','npm_config_cache')
    env={name:os.environ[name] for name in allowed if name in os.environ}; env['TERM']='xterm-256color'
    command=f"exec {shlex.quote(str(pi_bin))} --session-dir {shlex.quote(str(session_dir))} --offline --no-context-files --no-prompt-templates --no-themes --no-approve --no-extensions --no-skills -e {shlex.quote(package)}"
    os.chdir(work); os.execve('/usr/bin/tmux',['tmux','-L',tmux_socket,'new-session','-s',tmux_session,command],env)
resize(fd,42,120)
try:
    wait(fd,r'0\.0%/',timeout=12)
    mark=open_setup(fd); home=text(mark)
    expected_home=['Learning from conversations','Guidance and Advisor','Manage habits','Automation and privacy','Status and help','Turn everything off','Done']
    for label in expected_home: assert label in home, f'missing grouped home row: {label}'
    assert [home.index(label) for label in expected_home]==sorted(home.index(label) for label in expected_home), 'grouped home rows out of order'
    assert not re.search(r'Habit-learning model|Habit-assessment model|Local semantic files|OPENAI_API_KEY|dimensions|\b[0-9]{4}bp\b|checksum|provider endpoint',home,re.I)
    capture('home-wide',mark,expected_home)

    escape(fd); resize(fd,34,80); mark=open_setup(fd); narrow=text(mark)
    for label in expected_home: assert label in narrow, f'missing narrow grouped home row: {label}'
    capture('home-narrow',mark,expected_home)
    escape(fd); resize(fd,42,120); mark=open_setup(fd)

    mark=open_panel(fd,0,r'Learn from conversations'); learning=text(mark)
    for label in ['Learn from conversations','Habit-learning model','Analyze waiting examples','Review suggested habits','Back']: assert label in learning
    capture('learning',mark,['Learn from conversations','Habit-learning model','Analyze waiting examples','Review suggested habits','Back'])
    # A freshly isolated agent has no inherited credentials, so both model controls must fail closed.
    down(fd,1); mark=len(raw); enter(fd); wait(fd,r'No authenti',start=mark)
    back_home(fd); open_panel(fd,0,r'Learn from conversations')
    # Analyze remains fail-closed while capture is disabled and closes setup safely.
    down(fd,2); mark=len(raw); enter(fd); wait(fd,r'Turn on Save chat examples locally',start=mark)
    open_setup(fd); open_panel(fd,0,r'Learn from conversations')
    # Empty review remains explicit rather than opening an inert panel.
    down(fd,3); mark=len(raw); enter(fd); wait(fd,r'No review l',start=mark)
    back_home(fd)

    mark=open_panel(fd,1,r'Runtime Advisor'); guidance=text(mark)
    for label in ['Runtime Advisor','Advisor model','Same as habit assessment','Use approved habits','Habit-assessment model','Back']: assert label in guidance
    guidance=capture('guidance',mark,['Runtime Advisor','Advisor model','Use approved habits','Habit-assessment model','Back'])
    # A clean isolated agent must expose the Advisor control without inheriting an enabled state.
    assert re.search(r'Runtime Advisor\s+\[ \] OFF', guidance), 'Runtime Advisor did not start visibly OFF'
    # Advisor model starts with explicit inheritance rather than silently choosing a model.
    down(fd,1); mark=len(raw); enter(fd); wait(fd,r'Same as habit assessment',start=mark); escape(fd); drain(fd,.4)
    # Habit-assessment selection also refuses to inherit a live authenticated model.
    down(fd,3); mark=len(raw); enter(fd); wait(fd,r'No authenti',start=mark)
    back_home(fd); open_panel(fd,1,r'Runtime Advisor')
    # Approved-habit guidance still reaches its safety-file gate and can be cancelled.
    down(fd,2); mark=len(raw); enter(fd); wait(fd,r'Create default safety file',start=mark); mark=len(raw); escape(fd); wait(fd,r'Runtime Advisor',start=mark)
    back_home(fd)

    mark=open_panel(fd,2,r'Review approved habits'); habits=text(mark)
    for label in ['Review approved habits','Resolve possible duplicates','Prevent duplicate habits','Back']: assert label in habits
    capture('habits',mark,['Review approved habits','Resolve possible duplicates','Prevent duplicate habits','Back'])
    mark=len(raw); enter(fd); wait(fd,r'No approved',start=mark)
    down(fd,1); mark=len(raw); enter(fd); wait(fd,r'No habit le|No duplicate hab',start=mark)
    down(fd,2); mark=len(raw); enter(fd); wait(fd,r'Explain duplicate prevention',start=mark); mark=len(raw); enter(fd); wait(fd,r'Duplicate p',start=mark)
    back_home(fd)

    mark=open_panel(fd,3,r'Keep analyzed source examples'); automation=text(mark)
    for label in ['Keep analyzed source examples','Automatic Analyze schedule','Review prompts after Analyze','Local semantic files','Back']: assert label in automation
    capture('automation',mark,['Keep analyzed source examples','Automatic Analyze schedule','Review prompts after Analyze','Local semantic files','Back'])
    mark=len(raw); enter(fd); wait(fd,r'Keep analyzed source examples',start=mark); down(fd,1); mark=len(raw); enter(fd); wait(fd,r'Analyzed re',start=mark)
    # Schedule and review-prompt first actions remain explanation-only.
    down(fd,1); mark=len(raw); enter(fd); wait(fd,r'Explain automatic schedule',start=mark); mark=len(raw); enter(fd); wait(fd,r'Automatic s',start=mark)
    down(fd,2); mark=len(raw); enter(fd); wait(fd,r'Explain break-in review prompts',start=mark); mark=len(raw); enter(fd); wait(fd,r'Break-in re',start=mark)
    # Shared semantic-file explanation is contextual and does not prepare files.
    down(fd,3); mark=len(raw); enter(fd); wait(fd,r'Explain local semantic files',start=mark); enter(fd); drain(fd,.4)
    back_home(fd)

    mark=open_panel(fd,4,r'Learning —'); status=text(mark)
    for label in ['Learning —','Advisor —','Approved-habit guidance —','Habits —','Privacy and automation —','Local semantic files —','Back']: assert label in status
    assert not re.search(r'Advisor —[^\n]*(?:\bReady\b|\b0 queued\b)',status,re.I), 'status must not fabricate Advisor runtime or queue state'
    capture('status',mark,['Learning —','Advisor —','Approved-habit guidance —','Habits —','Privacy and automation —','Local semantic files —','Back']); back_home(fd)
    mark=open_panel(fd,0,r'Learn from conversations'); mark=len(raw); enter(fd); wait(fd,r'Learn from c',start=mark); back_home(fd)
    down(fd,5); mark=len(raw); enter(fd); wait(fd,r'Agent Exper',start=mark); all_off=capture('all-off',mark,['Learning from conversations','Guidance and Advisor','Turn everything off','Done'])
    assert re.search(r'Learning from conversations\s+OFF',all_off) and re.search(r'Guidance and Advisor\s+Advisor OFF · habits OFF',all_off), 'all-off action did not visibly disable learning, Advisor, and habits'
    escape(fd); send(fd,b'\x03',.3); send(fd,b'\x03',.3); drain(fd,1)
finally:
    transcript.parent.mkdir(parents=True,exist_ok=True); transcript.write_bytes(bytes(raw))
    try: os.kill(pid,signal.SIGTERM)
    except ProcessLookupError: pass
    try: os.waitpid(pid,0)
    except ChildProcessError: pass
    subprocess.run(['tmux','-L',tmux_socket,'kill-server'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print(f'installed Pi TUI smoke passed; transcript={transcript}; artifacts='+';'.join(f'{name}={path}' for name,path in artifact_paths.items()))
