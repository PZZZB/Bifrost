import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeCatalogModels, discoverClaudeModels } from '../src/claude-model-catalog.mjs';
const rows = [{ value: 'default', resolvedModel: 'claude-opus-v', displayName: 'Default' },
  { value: 'opus', resolvedModel: 'claude-opus-v', displayName: 'Opus', supportsEffort: true, supportedEffortLevels: ['high','invalid'] },
  { value: 'sonnet', displayName: 'Sonnet' }, { value: 'haiku', displayName: 'Haiku' },
  { value: 'claude-fable-5-1[1m]', displayName: 'Fable', description: 'Long context' }];
test('official selectable models retain exact upstream values, legacy IDs and extended variants without duplicating Default', () => {
  const models = claudeCatalogModels(rows);
  assert.deepEqual(models.map(m => m.id), ['claude-opus','claude-sonnet','claude-haiku','claude-fable-5-1-1m']);
  assert.equal(models.at(-1).upstream, 'claude-fable-5-1[1m]'); assert.equal(models[0].upstream, 'opus');
  assert.deepEqual(models[0].efforts, ['high']);
  assert.equal(models[1].supportsReasoning, undefined);
  assert.deepEqual(claudeCatalogModels([{ value: 'https://foreign.invalid', displayName: 'x' },{value:'bad\n',displayName:'bad'}]), []);
  assert.throws(() => claudeCatalogModels([...rows,{value:'claude-fable-5-1-1m',displayName:'Conflict'}]));
});
test('metadata discovery supplies no prompt, native tools, persistent session or inherited credentials and closes the query', async () => {
  let options, input, closed = false;
  const result = await discoverClaudeModels({binary:'/usr/bin/claude',configDir:'/private/identity/config',profileDir:'/private/identity/profile',stateDir:'/private/identity/state',
    env:{HOME:'/user',ANTHROPIC_API_KEY:'must-not-inherit',HTTPS_PROXY:'http://proxy.invalid'},queryImpl(value){options=value.options;input=value.prompt;
      return {supportedModels:async()=>rows,close(){closed=true;}};}});
  assert.equal(result.length,4);assert.equal(closed,true);assert.deepEqual(await input.next(),{done:true,value:undefined});
  assert.deepEqual(options.tools,[]);assert.deepEqual(options.mcpServers,{});assert.equal(options.persistSession,false);assert.equal(options.env.ANTHROPIC_API_KEY,undefined);
  assert.equal(options.env.HOME,'/private/identity/profile');assert.equal(options.env.HTTPS_PROXY,'http://proxy.invalid');
});
test('cancelled metadata discovery closes a stalled query without sending inference', async () => {
  let closed=false;
  await assert.rejects(discoverClaudeModels({binary:'/cli',configDir:'/profile/config',profileDir:'/profile/user',stateDir:'/profile/state',timeoutMs:10,
    queryImpl(){return{supportedModels:()=>new Promise(()=>{}),close(){closed=true;}};}}));
  assert.equal(closed,true);
});
