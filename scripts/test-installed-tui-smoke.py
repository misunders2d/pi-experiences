#!/usr/bin/env python3
import fcntl, json, os, pty, re, select, shutil, signal, struct, sys, termios, time, uuid
from pathlib import Path
if len(sys.argv)<3: raise SystemExit('usage: test-installed-tui-smoke.py INSTALLED_PACKAGE TRANSCRIPT')
package=str(Path(sys.argv[1]).resolve()); transcript=Path(sys.argv[2]).resolve()
state=Path(os.environ.get('AX_STATE_ROOT','/tmp/pi-experiences-042-tui-smoke-state')).resolve(); shutil.rmtree(state,ignore_errors=True); state.mkdir(parents=True,exist_ok=True)
work=state.parent/'pi-experiences-0.1.42-tui-work'; work.mkdir(parents=True,exist_ok=True)
receipt_id=str(uuid.uuid4()); receipt_dir=state/'receipts'/'scheduled-analyze'/'pending'; receipt_dir.mkdir(parents=True,exist_ok=True)
receipt_file=receipt_dir/f'20260717120000000-{receipt_id}.json'
receipt_file.write_text(json.dumps({'schema_version':1,'id':receipt_id,'kind':'scheduled_analyze','user_id':'owner','created_at':'2026-07-17T12:00:00.000Z','status':'ok','severity':'info','checked':3,'total_unread':3,'new_suggestions':0,'has_more':False},separators=(',',':')))
raw=bytearray(); csi=re.compile(rb'\x1b\[[0-?]*[ -/]*[@-~]'); osc=re.compile(rb'\x1b\][^\x07]*(?:\x07|\x1b\\)')
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
pid,fd=pty.fork()
if pid==0:
    env={**os.environ,'AX_STATE_ROOT':str(state),'TERM':'xterm-256color'}
    os.chdir(work); os.execvpe('pi',['pi','--no-extensions','--no-skills','-e',package],env)
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',42,120,0,0))
try:
    mark=len(raw); wait(fd,r'Scheduled Agent Experience Analyze update.*3 saved examples checked; 0 new suggestions created',timeout=8,start=mark)
    assert not receipt_file.exists(), 'visible scheduled summary consumes its receipt once'
    mark=len(raw); send(fd,b'/experience setup\r',.5); wait(fd,r'Agent Experience setup',start=mark)
    initial=text(mark)
    for label in ['Save chat examples locally','Choose model for habit learning','Choose model for habit assessment','Analyze saved examples now','Review suggested habits','Resolve duplicate habits','Review approved habits','Prevent duplicate habits','Keep analyzed source examples','Use approved habits before replies','Automatic schedule','Break-in review prompts','Show current settings','Explain these settings','Done']:
        assert label in initial, f'missing setup row: {label}'
    assert not re.search(r'OPENAI_API_KEY|embedding provider|dimensions|\b[0-9]{4}bp\b|checksum|source_refs|prompt_hash',initial,re.I)
    # Model chooser; Escape returns to setup.
    down(fd,1); mark=len(raw); enter(fd); wait(fd,r'Current model:|Recommended authenticated models',start=mark); escape(fd); drain(fd,.5)
    # Assessment-model chooser uses the same live authenticated picker; Escape returns to setup.
    down(fd,2); mark=len(raw); enter(fd); wait(fd,r'Choose model for habit assessment',start=mark); escape(fd); drain(fd,.5)
    # Empty review/resolution/browse paths return safely.
    down(fd,4); mark=len(raw); enter(fd); wait(fd,r'No review list yet',start=mark); drain(fd,.5)
    down(fd,5); mark=len(raw); enter(fd); wait(fd,r'No habit ledger yet|No duplicate habits are waiting',start=mark); drain(fd,.5)
    down(fd,6); mark=len(raw); enter(fd); wait(fd,r'No approved habits yet',start=mark); drain(fd,.5)
    # Local duplicate-prevention explanation: no download or service prompt.
    down(fd,7); mark=len(raw); enter(fd); wait(fd,r'Explain duplicate prevention',start=mark); mark=len(raw); enter(fd); wait(fd,r'Duplicate prevention compares only normalized',start=mark); drain(fd,.5)
    # Retention chooser; select 14 days.
    down(fd,8); mark=len(raw); enter(fd); wait(fd,r'30 days',start=mark); down(fd,1); mark=len(raw); enter(fd); wait(fd,r'deleted after 14 days',start=mark); drain(fd,.5)
    # Reminder enable reaches explicit safety-file gate; cancel it.
    down(fd,9); mark=len(raw); enter(fd); wait(fd,r'Create default safety file',start=mark); escape(fd); drain(fd,.5)
    # Scheduling defaults off; the first action remains explanation-only.
    down(fd,10); mark=len(raw); enter(fd); wait(fd,r'Explain automatic schedule',start=mark); mark=len(raw); enter(fd); wait(fd,r'optional local systemd user timer',start=mark); drain(fd,.5)
    # Break-in defaults off; explanation is review-only and non-mutating.
    down(fd,11); mark=len(raw); enter(fd); wait(fd,r'Explain break-in review prompts',start=mark); mark=len(raw); enter(fd); wait(fd,r'never approve, reject, merge, activate, or apply',start=mark); drain(fd,.5)
    # Status and help focused panels.
    down(fd,12); mark=len(raw); enter(fd); wait(fd,r'Agent Experience current settings',start=mark); escape(fd); drain(fd,.5)
    down(fd,13); mark=len(raw); enter(fd); wait(fd,r'Agent Experience setup help',start=mark); escape(fd); drain(fd,.5)
    # Analyze closes setup safely when learning is not enabled.
    down(fd,3); mark=len(raw); enter(fd); wait(fd,r'Turn on Save chat examples locally',start=mark); mark=len(raw); send(fd,b'/experience setup\r',.5); wait(fd,r'Agent Experience setup',start=mark)
    # Enable capture, then exercise all-off.
    mark=len(raw); enter(fd); wait(fd,r'Save chat examples locally: ON',start=mark); drain(fd,.5); down(fd,14); mark=len(raw); enter(fd); wait(fd,r'Agent Experience is OFF',start=mark); drain(fd,.5)
    escape(fd); send(fd,b'\x03',.3); send(fd,b'\x03',.3); drain(fd,1)
finally:
    transcript.parent.mkdir(parents=True,exist_ok=True); transcript.write_bytes(bytes(raw))
    try: os.kill(pid,signal.SIGTERM)
    except ProcessLookupError: pass
    try: os.waitpid(pid,0)
    except ChildProcessError: pass
print(f'installed Pi TUI smoke passed; transcript={transcript}')
