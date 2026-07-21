#!/usr/bin/env python3
import fcntl, json, os, pty, re, select, shutil, signal, struct, sys, termios, time, uuid
from pathlib import Path
if len(sys.argv)<3: raise SystemExit('usage: test-scheduled-notice-tui-smoke.py PACKAGE TRANSCRIPT')
package=str(Path(sys.argv[1]).resolve()); transcript=Path(sys.argv[2]).resolve()
state=Path(os.environ.get('AX_STATE_ROOT','/tmp/pi-experiences-047-notice-tui-state')).resolve(); shutil.rmtree(state,ignore_errors=True); state.mkdir(parents=True,exist_ok=True)
work=state.parent/'pi-experiences-0.1.47-notice-tui-work'; work.mkdir(parents=True,exist_ok=True)
receipt_dir=state/'receipts'/'scheduled-analyze'/'pending'; receipt_dir.mkdir(parents=True,exist_ok=True)
def write_receipt(stamp,checked):
    receipt_id=str(uuid.uuid4()); path=receipt_dir/f'{stamp}-{receipt_id}.json'
    path.write_text(json.dumps({'schema_version':1,'id':receipt_id,'kind':'scheduled_analyze','user_id':'owner','created_at':'2026-07-17T12:00:00.000Z','status':'ok','severity':'info','checked':checked,'total_unread':checked,'new_suggestions':0,'has_more':False},separators=(',',':')))
    return path
first=write_receipt('20260717120000000',3)
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
pid,fd=pty.fork()
if pid==0:
    env={**os.environ,'AX_STATE_ROOT':str(state),'TERM':'xterm-256color'}
    os.chdir(work); os.execvpe('pi',['pi','--no-extensions','--no-skills','-e',package],env)
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',42,120,0,0))
try:
    wait(fd,r'Scheduled Agent Experience Analyze update.*3 saved examples checked; 0 new suggestions created',timeout=8)
    assert not first.exists(), 'startup notice must consume receipt only after durable append'
    second=write_receipt('20260717120100000',4)
    mark=len(raw); send(fd,b'/reload\r',.3)
    wait(fd,r'Reloaded keybindings, extensions, skills, prompts, themes, and context files',timeout=8,start=mark)
    wait(fd,r'Scheduled Agent Experience Analyze update.*4 saved examples checked; 0 new suggestions created',timeout=8,start=mark)
    assert re.search(r'3 saved examples checked; 0 new suggestions created',text(mark),re.I), 'first durable notice must survive reload redraw'
    assert not second.exists(), 'post-reload notice must consume receipt only after durable append'
    mark=len(raw); send(fd,b'/reload\r',.3)
    wait(fd,r'Reloaded keybindings, extensions, skills, prompts, themes, and context files',timeout=8,start=mark)
    wait(fd,r'3 saved examples checked; 0 new suggestions created',timeout=8,start=mark)
    wait(fd,r'4 saved examples checked; 0 new suggestions created',timeout=8,start=mark)
    assert not list(receipt_dir.glob('*.json')), 'redraw must not recreate or duplicate receipts'
    send(fd,b'\x03',.3); send(fd,b'\x03',.3); drain(fd,1)
finally:
    transcript.parent.mkdir(parents=True,exist_ok=True); transcript.write_bytes(bytes(raw))
    try: os.kill(pid,signal.SIGTERM)
    except ProcessLookupError: pass
    try: os.waitpid(pid,0)
    except ChildProcessError: pass
print(f'scheduled notice Pi TUI smoke passed; transcript={transcript}')
