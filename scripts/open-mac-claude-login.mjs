import { readFile, writeFile, mkdir, rm, open } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root=join(homedir(),'Library/Application Support/ClaudeVPS');
const base=join(root,'Bifrost/ClaudeLogin');
const health=JSON.parse(await readFile(join(root,'Bifrost/Maintenance/health.json'),'utf8'));
const bridge=fileURLToPath(new URL('./claude-vm-login-bridge.py',import.meta.url));
const exec=promisify(execFile);
const headless=process.argv.includes('--headless-preflight');
if(process.argv.slice(2).some(a=>a!=='--headless-preflight'))throw new Error('Unexpected login option.');
const expectedIp=health.expectedExitIp;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const save=async(name,data)=>writeFile(join(base,name),JSON.stringify(data,null,2)+'\n',{mode:0o600});
let proxy,chrome,runLock,profile,closing=false,diagnostics='';
const environment=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','HOME','USER','LOGNAME','TMPDIR','LANG','LC_ALL','__CF_USER_TEXT_ENCODING'].includes(k)));
const pending=new Map();let nextId=0,buffer='';
const listeners=new Set();
function send(method,params={},sessionId){
 return new Promise((resolve,reject)=>{
  const id=++nextId;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('browser_command_timeout'));},25000);
  pending.set(id,{resolve,reject,timer});
  chrome.stdio[3].write(JSON.stringify({id,method,params,...sessionId?{sessionId}:{}})+'\0');
 });
}
function receive(data){
 buffer+=data.toString('utf8');let at;
 while((at=buffer.indexOf('\0'))>=0){
  const raw=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!raw)continue;
  const event=JSON.parse(raw);
  if(event.id){const item=pending.get(event.id);if(item){pending.delete(event.id);clearTimeout(item.timer);event.error?item.reject(new Error('browser_protocol_rejected')):item.resolve(event.result);}}
  else for(const listener of listeners)listener(event);
 }
}
async function startProxy(){
 proxy=spawn(join(root,'bin/mihomo'),['-d',join(base,'proxy-state'),'-f',join(base,'browser-proxy.json')],{stdio:'ignore',env:environment});
 for(let i=0;i<50;i++){
  const ok=await new Promise(resolve=>{const s=connect({host:'127.0.0.1',port:17892});s.once('connect',()=>{s.destroy();resolve(true)});s.once('error',()=>resolve(false));});
  if(ok)return;if(proxy.exitCode!==null)throw new Error('proxy_start_failed');await sleep(100);
 }
 throw new Error('proxy_start_timeout');
}
async function stopProxy(){if(proxy&&proxy.exitCode===null){const p=proxy;await new Promise(resolve=>{p.once('exit',resolve);p.kill('SIGTERM');});}proxy=null;}
async function acquireLock(){
 const path=join(base,'browser.lock');
 try{runLock=await open(path,'wx',0o600);}
 catch(e){
  if(e.code!=='EEXIST')throw e;
  const prior=JSON.parse(await readFile(path,'utf8'));
  if(!Number.isInteger(prior.pid)||prior.pid<=0)throw new Error('invalid_browser_lock');
  try{process.kill(prior.pid,0);throw new Error('login_browser_already_running');}
  catch(error){if(error.code!=='ESRCH')throw error;}
  await rm(path);runLock=await open(path,'wx',0o600);
 }
 await runLock.writeFile(JSON.stringify({pid:process.pid})+'\n');
}
async function close(){
 if(closing)return;closing=true;
 if(chrome&&chrome.exitCode===null){chrome.kill('SIGTERM');await sleep(300);if(chrome.exitCode===null)chrome.kill('SIGKILL');}
 await stopProxy();
 for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('browser_closed'));}pending.clear();
 if(profile)await rm(profile,{recursive:true,force:true});
 if(runLock){
  await rm(join(base,'browser-proxy.json'),{force:true});
  await runLock.close();await rm(join(base,'browser.lock'),{force:true});runLock=null;
 }
}
process.once('SIGINT',()=>{void close().finally(()=>process.exit(0));});
process.once('SIGTERM',()=>{void close().finally(()=>process.exit(0));});
async function vm(action){return JSON.parse((await exec('python3',[bridge,action],{timeout:25000,maxBuffer:32768})).stdout);}
async function sendToVm(message){
 return new Promise((resolve,reject)=>{
  const child=spawn('python3',[bridge,'send'],{stdio:['pipe','pipe','ignore'],env:environment});let reply='';
  const timer=setTimeout(()=>{child.kill();reject(new Error('vm_login_transport_timeout'));},15000);
  child.stdout.on('data',data=>{reply+=data;if(reply.length>8192)child.kill();});
  child.once('error',()=>{clearTimeout(timer);reject(new Error('vm_login_transport_failed'));});
  child.once('exit',code=>{clearTimeout(timer);try{const r=JSON.parse(reply);if(code!==0||r.sent!==true)throw new Error();resolve(r);}catch{reject(new Error('vm_login_transport_failed'));}});
  child.stdin.end(JSON.stringify(message));
 });
}
async function body(sessionId){return (await send('Runtime.evaluate',{expression:'document.body ? document.body.innerText : ""',returnByValue:true},sessionId)).result.value;}
async function navigate(sessionId,url,{interactive=false}={}){
 const result=await send('Page.navigate',{url},sessionId);if(result.errorText)return result;
 for(let i=0;i<150;i++){await sleep(200);const ready=(await send('Runtime.evaluate',{expression:'document.readyState',returnByValue:true},sessionId)).result.value;if(ready==='complete'||interactive&&ready==='interactive')return result;}
 if(interactive)return {...result,documentStillLoading:true};
 throw new Error('browser_page_not_ready');
}
async function authorizationPageMetadata(sessionId){
 return (await send('Runtime.evaluate',{expression:`(()=>{
   const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
   const inputs=[...document.querySelectorAll('input')].filter(visible);
   const controls=[...document.querySelectorAll('button,a,[role=button]')].filter(visible);
   return {host:location.hostname,title:document.title,bodyCharacters:(document.body?.innerText||'').trim().length,scriptCount:document.scripts.length,
    hasEmailInput:inputs.some(e=>e.type==='email'||e.autocomplete==='email'||e.name==='email'||/email|邮箱/i.test(e.placeholder||'')),
    hasSignInControl:controls.some(e=>/continue with|sign in|log in|authorize|google|apple|使用.*继续|授权|登录/i.test(e.textContent||''))};
  })()`,returnByValue:true},sessionId)).result.value;
}
async function showAuthorizationPage(sessionId){
 let shown;
 for(let i=0;i<80;i++){
  shown=await authorizationPageMetadata(sessionId);
  if(shown.hasEmailInput||shown.hasSignInControl)break;
  await sleep(250);
 }
 const script=`ObjC.import('AppKit'); var app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(${chrome.pid}); app.activateWithOptions(2); delay(0.3); String($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier===${chrome.pid});`;
 const focused=await exec('/usr/bin/osascript',['-l','JavaScript','-e',script],{timeout:5000,maxBuffer:1024}).catch(()=>null);
 await send('Page.bringToFront',{},sessionId);
 return {...shown,windowFrontmost:focused?.stdout.trim()==='true'};
}
try{
 await mkdir(base,{recursive:true,mode:0o700});
 await acquireLock();
 await rm(join(base,'browser-error.json'),{force:true});
 const cfg=JSON.parse(await readFile(join(root,'config/host-mihomo.json'),'utf8'));
 Object.assign(cfg,{'mixed-port':17892,'bind-address':'127.0.0.1','allow-lan':false,'lan-allowed-ips':['127.0.0.1/32'],'lan-disallowed-ips':[],authentication:[],'skip-auth-prefixes':[],ipv6:false,tun:{enable:false},'log-level':'silent'});
 delete cfg['external-controller'];delete cfg['external-controller-unix'];
 if(cfg['bind-address']!=='127.0.0.1'||cfg['mixed-port']!==17892||cfg.ipv6!==false||cfg.rules.some(r=>r.includes('DIRECT')))throw new Error('unsafe_proxy_configuration');
 await save('browser-proxy.json',cfg);await mkdir(join(base,'proxy-state'),{recursive:true,mode:0o700});await startProxy();
 profile=join(base,(headless?'preflight-profile-':'login-profile-')+randomUUID());
 await mkdir(join(profile,'Default'),{recursive:true,mode:0o700});await writeFile(join(profile,'Default','Preferences'),JSON.stringify({credentials_enable_service:false,profile:{password_manager_enabled:false}}),{mode:0o600});
 const args=['--user-data-dir='+profile,'--remote-debugging-pipe','--no-first-run','--no-default-browser-check','--disable-sync','--disable-background-networking','--disable-component-update','--disable-default-apps','--disable-quic',
 '--proxy-server=socks5://127.0.0.1:17892','--proxy-bypass-list=<-loopback>','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
 ...(headless?['--headless=new']:['--incognito','--new-window']),'about:blank'];
 chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args,{stdio:['ignore','ignore','pipe','pipe','pipe'],env:environment});chrome.stdio[4].on('data',receive);
 chrome.stderr.on('data',data=>{diagnostics=(diagnostics+data.toString('utf8')).slice(-16000);});
 chrome.once('exit',()=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('browser_exited'));}pending.clear();});
 const version=await send('Browser.getVersion');
 const targets=await send('Target.getTargets');const page=targets.targetInfos.find(x=>x.type==='page');if(!page)throw new Error('browser_page_missing');
 const {sessionId}=await send('Target.attachToTarget',{targetId:page.targetId,flatten:true});await send('Page.enable',{},sessionId);
 let nav=await navigate(sessionId,'https://api.ipify.org?format=json');if(nav.errorText)throw new Error('vps_precheck_failed');
 if(JSON.parse(await body(sessionId)).ip!==expectedIp)throw new Error('wrong_browser_exit');
 await stopProxy();
 nav=await navigate(sessionId,'https://1.1.1.1/cdn-cgi/trace?bifrost_login_probe='+randomUUID());
 const stopped=String(await body(sessionId));if(!nav.errorText&&!/ERR_(PROXY|SOCKS|NETWORK|CONNECTION)/.test(stopped))throw new Error('browser_fail_closed_not_verified');
 await startProxy();nav=await navigate(sessionId,'https://api.ipify.org?format=json&probe='+randomUUID());
 if(nav.errorText||JSON.parse(await body(sessionId)).ip!==expectedIp)throw new Error('browser_proxy_recovery_failed');
 const report={ok:true,checkedAt:new Date().toISOString(),browserVersion:version.product,browserVpsExitVerified:true,proxyStoppedRequestFailed:true,proxyRestoredSameExit:true,systemNetworkSandboxEnabled:false,browserFixedProxy:true,chromeOwnSandboxDisabled:false,realInference:false};
 await save('network-precheck.json',report);console.log(JSON.stringify(report));
 if(headless){await close();await rm(profile,{recursive:true,force:true});}
 else{
  await save('browser-state.json',{phase:'network_verified_waiting_for_vm_login',pid:process.pid,chromePid:chrome.pid,proxyPid:proxy.pid,checkedAt:new Date().toISOString()});
  await vm('start');
  let authorization=null,submitted=false,handling=false,prompted=false,formReady=false,lastUiProbe=0;
  const sessions=new Map([[page.targetId,sessionId]]);
  const stateBase=()=>({pid:process.pid,chromePid:chrome.pid,proxyPid:proxy?.pid,checkedAt:new Date().toISOString()});
  const saveAuthorizationPage=async shown=>{
   formReady=shown.hasEmailInput||shown.hasSignInControl;
   await save('browser-state.json',{...stateBase(),phase:formReady?'awaiting_owner_authorization':'authorization_page_needs_attention',authorizationHost:shown.host,authorizationPageTitle:shown.title,hasEmailInput:shown.hasEmailInput,hasSignInControl:shown.hasSignInControl,windowFrontmost:shown.windowFrontmost,bodyCharacters:shown.bodyCharacters,scriptCount:shown.scriptCount,credentialsRemainInVm:true});
  };
  const requests=new Map(),pageFailures=[];
  const locationOnly=raw=>{try{const u=new URL(raw);return {host:u.hostname,.../\.(?:js|css)$/.test(u.pathname)?{assetPath:u.pathname}:{}};}catch{return {};}};
  const recordFailure=entry=>{
   pageFailures.push(entry);if(pageFailures.length>20)pageFailures.shift();
   void save('authorization-diagnostics.json',{checkedAt:new Date().toISOString(),failures:pageFailures}).catch(()=>{});
  };
  listeners.add(event=>{
   const p=event.params;
   if(event.method==='Network.requestWillBeSent')requests.set(p.requestId,locationOnly(p.request.url));
   if(event.method==='Network.loadingFailed'&&!p.canceled)recordFailure({...requests.get(p.requestId),type:p.type,error:p.errorText});
   if(event.method==='Network.responseReceived'&&p.response.status>=400)recordFailure({...locationOnly(p.response.url),type:p.type,status:p.response.status});
   if(event.method==='Runtime.exceptionThrown')recordFailure({type:'javascript_exception',className:p.exceptionDetails.exception?.className||'Error',...locationOnly(p.exceptionDetails.url||'')});
   if(event.method==='Network.loadingFinished'||event.method==='Network.loadingFailed')requests.delete(p.requestId);
  });
  await save('authorization-diagnostics.json',{checkedAt:new Date().toISOString(),failures:[]});
  await send('Runtime.enable',{},sessionId);
  async function handleCallback(raw,targetSession){
   if(!authorization||submitted||handling)return;
   let u;try{u=new URL(raw);}catch{return;}
   const redirect=authorization.redirect;
   if(u.origin!==redirect.origin||u.pathname!==redirect.pathname)return;
   const returned=u.searchParams.get('state');
   if(returned&&returned!==authorization.state)throw new Error('oauth_state_mismatch');
   handling=true;
   try{
    if(redirect.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(redirect.hostname)){
     if(returned!==authorization.state||!u.searchParams.get('code'))return;
     await sendToVm({action:'callback',state:authorization.state,value:u.href});submitted=true;
    }else if(targetSession){
     // Read only the official callback page's displayed authorization code;
     // never read sign-in field values, passwords, cookies or browser storage.
     const result=await send('Runtime.evaluate',{expression:`(()=>{if(location.origin!==${JSON.stringify(redirect.origin)}||location.pathname!==${JSON.stringify(redirect.pathname)}||document.readyState!=='complete')return null;return [...document.querySelectorAll('input[readonly],textarea[readonly],code,pre')].filter(e=>e.getBoundingClientRect().width>0).map(e=>(e.value||e.textContent||'').trim());})()`,returnByValue:true},targetSession);
     const values=result.result.value;
     if(!Array.isArray(values))return;
     const code=values.find(v=>typeof v==='string'&&v.endsWith('#'+authorization.state)&&v.length<=4096&&!/[\x00-\x20\x7f]/.test(v));
     if(code){await sendToVm({action:'code',state:authorization.state,value:code});submitted=true;}
     else if(!prompted){
      prompted=true;await save('browser-state.json',{...stateBase(),phase:'manual_code_required'});
      // A local secure field is the standard fallback when the official page
      // displays a code. Its value travels over private stdin, never logs.
      const script='set r to display dialog "请将 Claude 官网显示的一次性授权码粘贴到这里。它会直接交给虚拟机中的 CLI；不要发到聊天里。" default answer "" with hidden answer with title "Claude：完成虚拟机登录" buttons {"取消", "完成登录"} default button "完成登录"\nreturn text returned of r';
      const reply=await exec('/usr/bin/osascript',['-e',script],{timeout:900000,maxBuffer:8192});
      const entered=reply.stdout.trim();if(!entered||entered.length>4096||/[\x00-\x20\x7f]/.test(entered))throw new Error('invalid_authorization_code');
      await sendToVm({action:'code',state:authorization.state,value:entered});submitted=true;
     }
    }
    if(submitted)await save('browser-state.json',{...stateBase(),phase:'finishing_vm_login'});
   }finally{handling=false;}
  }
  listeners.add(event=>{
   const url=event.method==='Network.requestWillBeSent'?event.params?.request?.url:event.method==='Page.frameNavigated'&&!event.params?.frame?.parentId?(event.params.frame.unreachableUrl||event.params.frame.url):null;
   if(url)void handleCallback(url,event.sessionId).catch(()=>save('browser-state.json',{...stateBase(),phase:'authorization_return_failed'}));
  });
  await send('Network.enable',{},sessionId);
  const deadline=Date.now()+30*60*1000;
  let lastProbe=0;
  while(Date.now()<deadline&&chrome.exitCode===null){
   if(Date.now()-lastProbe>2500){
    lastProbe=Date.now();const state=await vm(authorization?'status':'get-url');
    if(['authenticated','already_authenticated'].includes(state.phase)){
     await save('browser-state.json',{...stateBase(),phase:'authenticated',credentialsRemainInVm:true});await close();await rm(profile,{recursive:true,force:true});process.exit(0);
    }
    if(['failed','not_authenticated','cancelled'].includes(state.phase))throw new Error('vm_login_not_completed');
    if(!authorization&&state.url){
     const u=new URL(state.url),redirect=new URL(u.searchParams.get('redirect_uri'));
     if(u.protocol!=='https:'||!['claude.ai','claude.com','console.anthropic.com','platform.claude.com'].includes(u.hostname)||!u.pathname.includes('oauth')||!u.searchParams.get('state')||!u.searchParams.get('code_challenge'))throw new Error('invalid_cli_authorization_url');
     if(!(redirect.protocol==='https:'&&['platform.claude.com','console.anthropic.com','claude.ai','claude.com'].includes(redirect.hostname)||redirect.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(redirect.hostname)))throw new Error('invalid_cli_redirect');
     authorization={state:u.searchParams.get('state'),redirect};
     const opened=await navigate(sessionId,state.url,{interactive:true});if(opened.errorText)throw new Error('authorization_page_unreachable');
     const shown=await showAuthorizationPage(sessionId);
     await saveAuthorizationPage(shown);
    }
   }
   if(authorization&&!handling&&!submitted){
    if(!formReady&&Date.now()-lastUiProbe>5000){
     lastUiProbe=Date.now();const shown=await authorizationPageMetadata(sessionId);
     if(shown.hasEmailInput||shown.hasSignInControl)await saveAuthorizationPage(await showAuthorizationPage(sessionId));
    }
    const pages=(await send('Target.getTargets')).targetInfos.filter(p=>p.type==='page');
    for(const target of pages){
     let session=sessions.get(target.targetId);
     if(!session){session=(await send('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;sessions.set(target.targetId,session);await send('Page.enable',{},session);await send('Network.enable',{},session);}
     await handleCallback(target.url,session);
    }
   }
   await sleep(300);
  }
  if(authorization&&!submitted)await sendToVm({action:'cancel'}).catch(()=>{});
  await close();await save('browser-state.json',{phase:'closed',checkedAt:new Date().toISOString()});await rm(profile,{recursive:true,force:true});
 }
}catch(e){
 const reason=/^[a-z][a-z0-9_]+$/.test(e.message)?e.message:'login_browser_failed';
 await save('browser-error.json',{phase:'failed',reason,checkedAt:new Date().toISOString()}).catch(()=>{});
 if(runLock)await save('browser-state.json',{phase:'failed',reason,checkedAt:new Date().toISOString()}).catch(()=>{});
 console.log(JSON.stringify({ok:false,reason,browserReportedError:/ERROR|FATAL|sandbox|denied|failed/i.test(diagnostics)}));
 await close();process.exitCode=1;
}
