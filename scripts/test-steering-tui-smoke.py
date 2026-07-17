#!/usr/bin/env python3
import fcntl, os, pty, re, select, shutil, signal, struct, subprocess, sys, termios, time
from pathlib import Path
if len(sys.argv)<3: raise SystemExit('usage: test-steering-tui-smoke.py INSTALLED_PACKAGE TRANSCRIPT')
package=Path(sys.argv[1]).resolve(); transcript=Path(sys.argv[2]).resolve()
state=Path(os.environ.get('AX_STATE_ROOT','/tmp/pi-experiences-043-steering-tui-state')).resolve()
runtime=state.parent/'pi-experiences-0.1.43-steering-runtime'
shutil.rmtree(state,ignore_errors=True); shutil.rmtree(runtime,ignore_errors=True)
state.mkdir(parents=True,exist_ok=True); shutil.copytree(package,runtime)
os.symlink(package.parent,runtime/'node_modules',target_is_directory=True)
asset_source=Path(os.environ.get('AX_SELECTOR_MODEL_SOURCE_ROOT',str(Path.home()/'.agents/experience'))).resolve()
subprocess.run(['node','--experimental-strip-types',str(runtime/'scripts/seed-steering-tui-smoke.mjs'),str(state)],check=True,cwd=runtime,env={**os.environ,'AX_STATE_ROOT':str(state),'AX_USER_ID':'owner','AX_SELECTOR_MODEL_SOURCE_ROOT':str(asset_source)},stdout=subprocess.PIPE,stderr=subprocess.PIPE)
work=state.parent/'pi-experiences-0.1.43-steering-tui-work'; work.mkdir(parents=True,exist_ok=True)
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
def wait(fd,pattern,timeout=30,start=0):
    rx=re.compile(pattern,re.I|re.S); end=time.time()+timeout
    while time.time()<end:
        drain(fd,.2)
        if rx.search(text(start)): return
    raise AssertionError(f'TUI did not show /{pattern}/ within {timeout}s')
def send(fd,data,pause=.18): os.write(fd,data); drain(fd,pause)
pid,fd=pty.fork()
if pid==0:
    env={**os.environ,'AX_STATE_ROOT':str(state),'AX_USER_ID':'owner','TERM':'xterm-256color'}
    os.chdir(work); os.execvpe('pi',['pi','--no-extensions','--no-skills','--thinking','high','-e',str(package)],env)
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',42,120,0,0))
try:
    drain(fd,2); mark=len(raw)
    send(fd,b'Please provide steering smoke status.',.1)
    submitted_mark=len(raw); submitted_at=time.monotonic()
    send(fd,b'\r',.05)
    wait(fd,r'Please provide steering smoke status\.',timeout=1.5,start=submitted_mark)
    submit_render_ms=round((time.monotonic()-submitted_at)*1000)
    assert submit_render_ms<1500, 'submitted user message must render immediately, before selector preprocessing finishes'
    wait(fd,r'Steered by habit\s*[·.]\s*When asked for steering smoke status',timeout=30,start=submitted_mark)
    collapsed=text(submitted_mark)
    prompt_pos=collapsed.rfind('Please provide steering smoke status.')
    marker_pos=collapsed.rfind('Steered by habit')
    assert prompt_pos>=0 and marker_pos>prompt_pos, 'response marker must render after the triggering user prompt'
    assert 'Do: Answer exactly “Steering smoke OK.”' not in collapsed, 'steering entry must start collapsed'
    assert 'When doing nontrivial code review' not in collapsed, 'behavior-token false match must not appear in response marker'
    wait(fd,r'(Thinking|Working)\.{0,3}',timeout=12,start=marker_pos)
    active=text(mark)
    assert active.find('Thinking',marker_pos)>marker_pos or active.find('Working',marker_pos)>marker_pos, 'marker must render before response work starts'
    wait(fd,r'Steering smoke OK\.',timeout=60,start=marker_pos)
    answered=text(mark)
    answer_pos=answered.find('Steering smoke OK.',marker_pos)
    assert answer_pos>marker_pos, 'the response receiving hidden habit guidance must render after its marker'
    send(fd,b'\x0f',.3)  # app.tools.expand (Ctrl+O)
    wait(fd,r'When: When asked for steering smoke status',timeout=12,start=mark)
    wait(fd,r'Do: Answer exactly [“\"]Steering smoke OK\.[”\"]',timeout=12,start=mark)
    visible=text(mark)
    marker=visible.rfind('Steered by habit')
    assert marker>=0
    assert visible.find('When: When asked for steering smoke status',marker)>marker
    assert not re.search(r'steering-smoke-approved-habit|confidence_bp|checksum|source_refs|prompt_hash|provider|model',visible,re.I), 'visible marker leaked internals'
    send(fd,b'\x03',.3); send(fd,b'\x03',.3); drain(fd,1)
finally:
    transcript.parent.mkdir(parents=True,exist_ok=True); transcript.write_bytes(bytes(raw))
    try: os.kill(pid,signal.SIGTERM)
    except ProcessLookupError: pass
    try: os.waitpid(pid,0)
    except ChildProcessError: pass
print(f'installed steering TUI smoke passed; submit_render_ms={submit_render_ms}; transcript={transcript}')
