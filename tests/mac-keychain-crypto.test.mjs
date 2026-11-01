import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { CurrentUserCredentialStore } from '../src/current-user-credential-store.mjs';
function mockSecurity(){const keys=new Map(),calls=[];let denied=false;return{calls,keys,set denied(value){denied=value;},
 exec(file,args,options,done){calls.push({file,args});if(denied){queueMicrotask(()=>done(Object.assign(new Error('PRIVATE failure'),{code:36})));return{};}
  if(args[0]==='find-generic-password'){const account=args[args.indexOf('-a')+1];queueMicrotask(()=>keys.has(account)?done(null,keys.get(account)):done(Object.assign(new Error('missing'),{code:44})));return{};}
  assert.deepEqual(args,['-i']);return{stdin:new Writable({write(bytes,_encoding,next){const line=bytes.toString(),account=/ -a ([a-f0-9]{64}) /.exec(line)?.[1],key=/ -w ([a-f0-9]{64})\n$/.exec(line)?.[1];
   assert.ok(account&&key);if(!keys.has(account))keys.set(account,key);done(null,'');next();}})};
 }};}
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'bifrost-keychain-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'credential.json'),os=mockSecurity();
 const create=(namespace='Bifrost.Test.v1')=>new CurrentUserCredentialStore({path,namespace,platform:'darwin',execFileImpl:os.exec});return{path,os,create};}
test('Mac credentials use Keychain-held keys and authenticated encrypted files, preserving records across instances',async t=>{
 const f=await fixture(t),store=f.create(),record={apiKey:'private-fixture-account-key'};
 assert.equal(await store.load(),null);assert.equal(f.os.calls.length,0);await store.save(record);
 const file=await readFile(f.path,'utf8');assert.doesNotMatch(file,/private-fixture-account-key/);assert.equal(JSON.parse(file).protection,'macos-keychain-aes-gcm');
 assert.deepEqual(await f.create().load(),record);assert.equal(f.os.keys.size,1);
 assert.doesNotMatch(JSON.stringify(f.os.calls),/private-fixture-account-key/);
 for(const key of f.os.keys.values())assert.equal(JSON.stringify(f.os.calls).includes(key),false,'Encryption keys cannot appear in argv');
 await store.clear();assert.equal(await store.load(),null);
});
test('Mac namespace mismatch, ciphertext tampering and Keychain refusal fail closed without overwriting an existing record',async t=>{
 const f=await fixture(t),record={apiKey:'private-fixture-key'};await f.create().save(record);const original=await readFile(f.path,'utf8');
 await assert.rejects(f.create('Other.Namespace').load(),e=>e.code==='keychain_failed');
 f.os.denied=true;await assert.rejects(f.create().save(record),e=>e.code==='keychain_failed'&&!String(e).includes('PRIVATE'));
 assert.equal(await readFile(f.path,'utf8'),original);f.os.denied=false;
 const data=JSON.parse(original),bytes=Buffer.from(data.ciphertext,'base64');bytes[bytes.length-1]^=1;data.ciphertext=bytes.toString('base64');await writeFile(f.path,JSON.stringify(data));
 await assert.rejects(f.create().load(),e=>e.code==='keychain_failed');
});
test('Mac never decrypts a Windows envelope with a fallback protector',async t=>{
 const f=await fixture(t);await writeFile(f.path,JSON.stringify({version:1,protection:'dpapi-current-user',ciphertext:'ZmFrZQ=='}));
 await assert.rejects(f.create().load(),e=>e.code==='invalid_envelope');assert.equal(f.os.calls.length,0);
});
