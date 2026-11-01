import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readLaunchdOwner } from '../src/launchd-owner.mjs';
const options={label:'local.bifrost.test',projectDir:'/app',stateDir:'/state',processId:123,parentProcessId:1,uid:501,home:'/home',binary:'/node'};
function fixture(){const config={Label:options.label,KeepAlive:true,WorkingDirectory:'/app',ProgramArguments:['/node',join('/app','src','main.mjs')],EnvironmentVariables:{BRIDGE_STATE_DIR:'/state',BRIDGE_LAUNCHD_LABEL:options.label}};
 let pid=123,mode=0o600;
 return{config,set pid(v){pid=v;},set mode(v){mode=v;},args:{...options,inspect:async()=>({uid:501,mode,isFile:()=>true}),exec:async(file)=>({stdout:file.endsWith('plutil')?JSON.stringify(config):`state = running\n pid = ${pid}\n`})}};}
test('only the exact current process in its matching KeepAlive LaunchAgent can request a supervised restart',async()=>{
 const f=fixture(),owner=await readLaunchdOwner(f.args);assert.match(owner.OwnerId,/^[A-F0-9]{64}$/);f.pid=124;assert.equal(await readLaunchdOwner(f.args),null);
 f.pid=123;f.config.KeepAlive=false;assert.equal(await readLaunchdOwner(f.args),null);f.config.KeepAlive=true;
 f.config.ProgramArguments[1]='/foreign/main.mjs';assert.equal(await readLaunchdOwner(f.args),null);
});
test('missing labels, unsupervised parents, writable identity files and unavailable launchctl never allow restart',async()=>{
 const f=fixture();for(const patch of [{label:undefined},{label:'../other'},{parentProcessId:23},{exec:async()=>{throw new Error('offline');}}])assert.equal(await readLaunchdOwner({...f.args,...patch}),null);
 f.mode=0o666;assert.equal(await readLaunchdOwner(f.args),null);
});
