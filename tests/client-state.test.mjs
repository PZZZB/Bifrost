import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientStateCodec } from '../src/client-state.mjs';
import { redact } from '../src/storage.mjs';
const scope = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const model = 'B-gpt-6.1-sol', codec = () => new ClientStateCodec({ secret: 's'.repeat(48) });

test('vendor state is authenticated by user, model and master secret without retaining plaintext properties', () => {
  const cipher = codec(), value = cipher.seal('private-upstream-state', scope, model);
  assert.equal(cipher.open(value, scope, model), 'private-upstream-state');
  assert.equal(JSON.stringify(cipher), '{}'); assert.doesNotMatch(value, /private/);
  for (const fn of [() => cipher.open(value, other, model), () => cipher.open(value, scope, 'B-gpt-6-astra'),
    () => new ClientStateCodec({ secret: 't'.repeat(48) }).open(value, scope, model), () => cipher.open(value.slice(0,-3)+'abc', scope, model)]) {
    assert.throws(fn, error => error.status === 409 && error.code === 'client_state_invalid');
  }
});
test('request unwrapping retains explicit history, function content and caller body without mutating inputs', () => {
  const cipher = codec(), token = cipher.seal('opaque-native', scope, model);
  const body = { model, tools: [{type:'function',name:'run',parameters:{type:'object'}}], input: [
    {role:'user',content:[{type:'input_text',text:'literal file_id item_reference'}]},
    {type:'reasoning',encrypted_content:token,summary:[]},
    {type:'function_call_output',call_id:'call_1',output:'literal text'},
  ] };
  const result = cipher.input(body, scope);
  assert.equal(result.store,false); assert.equal(result.input[1].encrypted_content,'opaque-native');
  assert.equal(body.input[1].encrypted_content,token); assert.equal(body.store,undefined);
});
test('public users cannot retrieve vendor-stored conversations, files, containers or hosted tools by ID', () => {
  const cipher=codec();
  const values=[{previous_response_id:'resp_private'}, {conversation:'conv_private'}, {store:true}, {background:true},
    {input:[{type:'item_reference',id:'msg_private'}]}, {input:[{type:'message',role:'user',content:[{type:'input_image',file_id:'file_private'}]}]},
    {input:[{role:'user',content:[{type:'input_file',file_id:'file_private'}]}]}, {input:[{type:'container_file_citation',container_id:'private'}]},
    {tools:[{type:'mcp',server_url:'https://private.invalid'}]}, {tools:[{type:'file_search',vector_store_ids:['vs_private']}]},
    {tools:[{type:'namespace',name:'wrapped',tools:[{type:'code_interpreter',container:'private'}]}]}];
  for(const value of values) assert.throws(()=>cipher.input({model,...value},scope), error=>error.status===400);
});
test('Responses JSON output and streaming item/completed events wrap every opaque continuation', async () => {
  const cipher=codec(), item={type:'reasoning',encrypted_content:'native-private',summary:[]};
  const data=await (await cipher.response(Response.json({output:[item]}),scope,model)).json();
  assert.equal(cipher.open(data.output[0].encrypted_content,scope,model),'native-private');
  const event={type:'response.completed',response:{status:'completed',output:[item,{type:'message',role:'assistant',content:[{type:'output_text',text:'中文'}]}]}};
  const bytes=new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  const stream=new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}});
  const result=await (await cipher.response(new Response(stream,{headers:{'content-type':'text/event-stream'}}),scope,model)).text();
  const parsed=JSON.parse(result.split('\n')[0].slice(6));
  assert.equal(cipher.open(parsed.response.output[0].encrypted_content,scope,model),'native-private');
  assert.match(result,/中文/); assert.match(result,/\[DONE\]/); assert.doesNotMatch(result,/native-private/);
});
test('malformed or truncated upstream events reject the stream instead of inventing successful completion',async()=>{
  for(const text of ['data: {broken}\n\n','data: {"type":"response.completed"}']){
    const result=await codec().response(new Response(text,{headers:{'content-type':'text/event-stream'}}),scope,model);
    await assert.rejects(result.text());
  }
});
test('new client key, session and invitation values are redacted from ordinary log errors',()=>{
  for(const prefix of ['bfk_','bfs_','bfi_']) assert.equal(redact(`failure ${prefix}${'x'.repeat(43)}`),'failure [REDACTED]');
});
