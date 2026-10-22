import test from 'node:test';
import assert from 'node:assert/strict';
import { translateResponses } from '../src/codebuddy-responses.mjs';
import { CODEBUDDY_MODEL } from '../src/codebuddy-provider.mjs';

const field = 'internal_chat_message_metadata_passthrough';
const marker = 'PRIVATE_INTERNAL_METADATA_MUST_NOT_REACH_MODEL';
function fixture() {
  return { model: CODEBUDDY_MODEL.id, tools: [
    { type: 'function', name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    { type: 'custom', name: 'apply_patch', format: { type: 'text' } },
    { type: 'tool_search', execution: 'client' },
  ], input: [
    { role: 'system', content: 'System priority remains unchanged.' },
    { role: 'developer', content: 'Use only the declared client tools.' },
    { role: 'user', content: 'Inspect the local fixture.' },
    { type: 'message', role: 'assistant', content: 'Reading.' },
    { type: 'reasoning', id: 'fixture-reasoning', encrypted_content: 'fixture-opaque-state', summary: [] },
    { type: 'function_call', name: 'read_file', call_id: 'read-one', arguments: '{"path":"fixture.txt"}' },
    { type: 'function_call_output', call_id: 'read-one', output: 'Original file contents.' },
    { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch-one', input: '*** Begin Patch\n*** End Patch\n' },
    { type: 'custom_tool_call_output', call_id: 'patch-one', output: 'Original patch result.' },
    { type: 'tool_search_call', call_id: 'search-one', execution: 'client', arguments: { query: 'fixture tool' } },
    { type: 'tool_search_output', call_id: 'search-one', execution: 'client', tools: [] },
  ] };
}
function translate(body) {
  return translateResponses(body, 'fixture-priority-marker', {
    openState: () => [{ type: 'thinking', thinking: '', signature: 'fixture-provider-state' }],
  });
}
function withMetadata(body, value) {
  return { ...structuredClone(body), input: body.input.map(item => ({ ...structuredClone(item), [field]: structuredClone(value) })) };
}

test('all supported input item kinds accept object or null internal metadata without changing provider content', () => {
  const original = fixture(), expected = translate(original);
  for (const metadata of [null, {}, { turn_id: marker, create_time: 1792659326.5,
    cell_id: marker, executed_tool_calls: [{ id: marker }], tool_calls_complete: true }]) {
    const body = withMetadata(original, metadata), before = structuredClone(body), translated = translate(body);
    assert.deepEqual(translated.upstream, expected.upstream);
    assert.deepEqual(translated.tools.declarations, expected.tools.declarations);
    assert.deepEqual(body, before);
    assert.equal(JSON.stringify(translated.upstream).includes(marker), false);
    assert.equal(JSON.stringify(translated.upstream).includes(field), false);
  }
});

test('invalid metadata types and non-finite values are rejected on every supported input item kind', () => {
  for (const [index, item] of fixture().input.entries()) {
    for (const invalid of ['text', 7, true, [], [null], { create_time: Number.POSITIVE_INFINITY }]) {
      const body = fixture(); body.input[index][field] = invalid;
      assert.throws(() => translate(body), error => error.status === 400 && error.param.endsWith(`.${field}`),
        `${item.type ?? item.role}: ${JSON.stringify(invalid)}`);
    }
  }
});

test('accepting internal metadata does not allow other unknown item, body or content fields', () => {
  const original = withMetadata(fixture(), { turn_id: marker });
  for (let index = 0; index < original.input.length; index++) {
    const body = structuredClone(original); body.input[index].future_unknown_field = marker;
    assert.throws(() => translate(body), error => error.status === 400 && error.param.endsWith('.future_unknown_field')
      && !error.message.includes(marker));
  }
  const bodyField = { ...original, [field]: { turn_id: marker } };
  assert.throws(() => translate(bodyField), error => error.status === 400 && error.param === `body.${field}`);
  const contentField = structuredClone(original);
  contentField.input[2].content = [{ type: 'input_text', text: 'Original text.', [field]: { turn_id: marker } }];
  assert.throws(() => translate(contentField), error => error.status === 400 && error.param === `input.message.content.${field}`);
});

test('a same-named key inside actual tool arguments and results remains ordinary user data', () => {
  const body = withMetadata(fixture(), { turn_id: marker });
  body.input[5].arguments = JSON.stringify({ path: 'fixture.txt', [field]: { value: 'TOOL_ARGUMENT_DATA' } });
  body.input[6].output = JSON.stringify({ [field]: { value: 'TOOL_RESULT_DATA' } });
  const translated = translate(body);
  const blocks = translated.upstream.messages.flatMap(message => message.content);
  assert.deepEqual(blocks.find(block => block.type === 'tool_use' && block.id === 'read-one').input[field], { value: 'TOOL_ARGUMENT_DATA' });
  assert.equal(blocks.find(block => block.type === 'tool_result' && block.tool_use_id === 'read-one').content[0].text, body.input[6].output);
  assert.equal(JSON.stringify(translated.upstream).includes(marker), false);
});
