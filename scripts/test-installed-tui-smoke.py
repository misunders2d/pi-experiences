#!/usr/bin/env python3
import fcntl, os, pty, re, select, shutil, signal, struct, sys, termios, time
from pathlib import Path
if len(sys.argv)<3: raise SystemExit('usage: test-installed-tui-smoke.py INSTALLED_PACKAGE TRANSCRIPT')
package=str(Path(sys.argv[1]).resolve()); transcript=Path(sys.argv[2]).resolve()
artifacts=transcript.parent/f'{transcript.stem}-artifacts'; artifacts.mkdir(parents=True,exist_ok=True)
state=Path(os.environ.get('AX_STATE_ROOT','/tmp/pi-experiences-047-tui-smoke-state')).resolve(); shutil.rmtree(state,ignore_errors=True); state.mkdir(parents=True,exist_ok=True)
work=state.parent/'pi-experiences-0.1.49-tui-work'; work.mkdir(parents=True,exist_ok=True)
raw=bytearray(); csi=re.compile(rb'\x1b\[[0-?]*[ -/]*[@-~]'); osc=re.compile(rb'\x1b\][^\x07]*(?:\x07|\x1b\\)')
artifact_paths={}
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
        if rx.search(text(start)): return
    raise AssertionError(f'TUI did not show /{pattern}/ within {timeout}s')
def send(fd,data,pause=.18): os.write(fd,data); drain(fd,pause)
def down(fd,count):
    for _ in range(count): send(fd,b'\x1b[B',.05)
def enter(fd): send(fd,b'\r',.3)
def escape(fd): send(fd,b'\x1b',.3)
def resize(fd,rows,cols): fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0)); drain(fd,.3)
def capture(name,start):
    path=artifacts/f'{name}.txt'; path.write_text(text(start),encoding='utf-8'); artifact_paths[name]=str(path)
def open_setup(fd):
    mark=len(raw); send(fd,b'/experience setup\r',.5); wait(fd,r'Agent Experience setup',start=mark); return mark
def back_home(fd):
    mark=len(raw); escape(fd); wait(fd,r'Agent Experience setup',start=mark); return mark
def open_panel(fd,index,pattern):
    down(fd,index); mark=len(raw); enter(fd); wait(fd,pattern,start=mark); return mark
pid,fd=pty.fork()
if pid==0:
    env={**os.environ,'AX_STATE_ROOT':str(state),'TERM':'xterm-256color'}
    os.chdir(work); os.execvpe('pi',['pi','--no-extensions','--no-skills','-e',package],env)
resize(fd,42,120)
try:
    wait(fd,r'0\.0%/',timeout=12)
    mark=open_setup(fd); home=text(mark)
    expected_home=['Learning from conversations','Guidance and Advisor','Manage habits','Automation and privacy','Status and help','Turn everything off','Done']
    for label in expected_home: assert label in home, f'missing grouped home row: {label}'
    assert [home.index(label) for label in expected_home]==sorted(home.index(label) for label in expected_home), 'grouped home rows out of order'
    assert not re.search(r'Habit-learning model|Habit-assessment model|Local semantic files|OPENAI_API_KEY|dimensions|\b[0-9]{4}bp\b|checksum|provider endpoint',home,re.I)
    capture('home-wide',mark)

    escape(fd); resize(fd,34,80); mark=open_setup(fd); narrow=text(mark)
    for label in expected_home: assert label in narrow, f'missing narrow grouped home row: {label}'
    capture('home-narrow',mark)
    escape(fd); resize(fd,42,120); mark=open_setup(fd)

    mark=open_panel(fd,0,r'Learn from conversations'); learning=text(mark)
    for label in ['Learn from conversations','Habit-learning model','Analyze waiting examples','Review suggested habits','Back']: assert label in learning
    capture('learning',mark); back_home(fd)

    mark=open_panel(fd,1,r'Runtime Advisor'); guidance=text(mark)
    for label in ['Runtime Advisor','Advisor model','Same as habit assessment','Use approved habits','Habit-assessment model','Back']: assert label in guidance
    capture('guidance',mark)
    down(fd,1); mark=len(raw); enter(fd); wait(fd,r'Same as habit assessment',start=mark); escape(fd); drain(fd,.4)
    back_home(fd)

    mark=open_panel(fd,2,r'Review approved habits'); habits=text(mark)
    for label in ['Review approved habits','Resolve possible duplicates','Prevent duplicate habits','Back']: assert label in habits
    capture('habits',mark); back_home(fd)

    mark=open_panel(fd,3,r'Keep analyzed source examples'); automation=text(mark)
    for label in ['Keep analyzed source examples','Automatic Analyze schedule','Review prompts after Analyze','Local semantic files','Back']: assert label in automation
    capture('automation',mark)
    down(fd,3); mark=len(raw); enter(fd); wait(fd,r'Explain local semantic files',start=mark); enter(fd); drain(fd,.4)
    back_home(fd)

    mark=open_panel(fd,4,r'Learning —'); status=text(mark)
    for label in ['Learning —','Advisor —','Approved-habit guidance —','Habits —','Privacy and automation —','Local semantic files —','Back']: assert label in status
    capture('status',mark); back_home(fd)

    mark=open_panel(fd,0,r'Learn from conversations'); mark=len(raw); enter(fd); wait(fd,r'Learn from conversations\s+\[x\] ON',start=mark); back_home(fd)
    down(fd,5); mark=len(raw); enter(fd); wait(fd,r'Agent Experience is OFF',start=mark); drain(fd,.5)
    escape(fd); send(fd,b'\x03',.3); send(fd,b'\x03',.3); drain(fd,1)
finally:
    transcript.parent.mkdir(parents=True,exist_ok=True); transcript.write_bytes(bytes(raw))
    try: os.kill(pid,signal.SIGTERM)
    except ProcessLookupError: pass
    try: os.waitpid(pid,0)
    except ChildProcessError: pass
print(f'installed Pi TUI smoke passed; transcript={transcript}; artifacts='+';'.join(f'{name}={path}' for name,path in artifact_paths.items()))
