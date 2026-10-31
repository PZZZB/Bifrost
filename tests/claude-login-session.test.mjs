import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const exec=promisify(execFile);
const modulePath=fileURLToPath(new URL('../scripts/claude-vm-login-session.py',import.meta.url));
const unix={skip:process.platform==='win32'};
const url='https://claude.com/oauth/authorize?state=fixture-state&code_challenge=fixture-pkce&redirect_uri=http%3A%2F%2F127.0.0.1%3A43567%2Fcallback';
async function check(action,data){
 const program="import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('login',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nd=json.loads(sys.argv[3])\ntry:\n r=m.authorization_url(d) if sys.argv[2]=='url' else m.validate_message(d['message'],d['url']);print(json.dumps({'accepted':True,'result':r}))\nexcept ValueError: print(json.dumps({'accepted':False}))";
 return JSON.parse((await exec('python3',['-c',program,modulePath,action,JSON.stringify(data)],{timeout:5000})).stdout);
}
test('CLI authorization extraction waits for a full line and rejects nonofficial or ambiguous URLs',unix,async()=>{
 assert.equal((await check('url',url)).result,null);
 assert.equal((await check('url',url+'\n')).result,url);
 assert.equal((await check('url',url.replace('claude.com','untrusted.invalid')+'\n')).result,null);
 assert.equal((await check('url',url+'&state=second\n')).result,null);
 assert.equal((await check('url',url+'&state=\n')).result,null);
 assert.equal((await check('url',url.replace('https://','https://name@')+'\n')).result,null);
});
test('manual code delivery requires this login state and rejects control characters',unix,async()=>{
 assert.deepEqual((await check('message',{url,message:{action:'code',state:'fixture-state',value:'fixture-code#fixture-state'}})).result,['code','fixture-code#fixture-state']);
 for(const message of [{action:'code',state:'other-state',value:'fixture-code'}, {action:'code',state:'fixture-state',value:'code\ncommand'}, {action:'code',state:'fixture-state',value:''}])assert.equal((await check('message',{url,message})).accepted,false);
});
test('callback forwarding is restricted to the exact guest-loopback URI and original state',unix,async()=>{
 const callback='http://127.0.0.1:43567/callback?code=fixture-code&state=fixture-state';
 assert.equal((await check('message',{url,message:{action:'callback',state:'fixture-state',value:callback}})).accepted,true);
 for(const value of [callback.replace(':43567',':43568'),callback.replace('/callback','/other'),callback.replace('127.0.0.1','remote.invalid'),callback+'&state=second',callback+'&state=',callback+'&code=second',callback.replace('code=fixture-code','code='),callback.replace('state=fixture-state','state=other')])assert.equal((await check('message',{url,message:{action:'callback',state:'fixture-state',value}})).accepted,false);
});
test('a private cancellation can stop a session before an authorization URL exists',unix,async()=>{
 assert.deepEqual((await check('message',{url:'',message:{action:'cancel'}})).result,['cancel',null]);
});

test('private authorization transport delivers stdin to the FIFO without evaluating it as shell input',unix,async()=>{
 const bridge=fileURLToPath(new URL('../scripts/claude-vm-login-bridge.py',import.meta.url));
 const fixture=String.raw`
import importlib.util,json,os,pty,select,signal,subprocess,sys,tempfile,termios,threading,tty
from pathlib import Path
s=importlib.util.spec_from_file_location('bridge',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
master,slave=pty.openpty();tty.setraw(slave)
shell=subprocess.Popen(['/bin/bash','--noprofile','--norc'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
running=True
def relay():
 while running:
  try:
   ready,_,_=select.select([master,shell.stdout],[],[],0.1)
   for source in ready:
    part=os.read(master if source==master else shell.stdout.fileno(),16384)
    if not part:return
    if source==master:shell.stdin.write(part);shell.stdin.flush()
    else:os.write(master,part)
  except (OSError,ValueError):return
thread=threading.Thread(target=relay,daemon=True);thread.start()
try:
 with tempfile.TemporaryDirectory() as folder:
  m.GUEST=folder;m.device=lambda:os.ttyname(slave)
  fifo=Path(folder)/'input.fifo';os.mkfifo(fifo,0o600)
  reader=os.open(fifo,os.O_RDWR|os.O_NONBLOCK)
  marker=Path(folder)/'must-not-exist'
  message={'action':'code','state':'fixture-state','value':'fixture-$(touch '+str(marker)+')#fixture-state'}
  before=termios.tcgetattr(slave)
  result=m.send_message(message)
  received=json.loads(os.read(reader,4096));os.close(reader)
  print(json.dumps({'sent':result=={'sent':True},'sameMessage':received==message,'evaluated':marker.exists(),'ttyRestored':termios.tcgetattr(slave)==before}))
finally:
 running=False
 try:os.killpg(shell.pid,signal.SIGKILL)
 except ProcessLookupError:pass
 shell.wait(timeout=3);thread.join(timeout=1);os.close(master);os.close(slave)
`;
 const result=JSON.parse((await exec('python3',['-c',fixture,bridge],{timeout:15000})).stdout);
 assert.deepEqual(result,{sent:true,sameMessage:true,evaluated:false,ttyRestored:true});
});
