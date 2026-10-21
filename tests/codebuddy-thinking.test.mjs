import test from 'node:test';
import assert from 'node:assert/strict';
import { thinkingOptions, thinkingText } from '../src/codebuddy-thinking.mjs';

test('maps native effort controls and honors the requested summary display', () => {
  assert.deepEqual(thinkingOptions(), { body: { reasoning_effort: 'high', reasoning_summary: 'auto' },
    visible: false, mode: 'adaptive', display: 'omitted' });
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    const options = thinkingOptions({ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort } });
    assert.equal(options.visible, true); assert.equal(options.body.reasoning_effort, effort);
    assert.equal(options.body.reasoning_summary, 'auto');
  }
  assert.equal(thinkingOptions({ thinking: { type: 'adaptive' } }).visible, false);
  assert.equal(thinkingOptions({ thinking: { type: 'adaptive', display: 'omitted' } }).visible, false);
});

test('unrepresentable budgets, disabling, max effort and extra controls cannot silently change meaning', () => {
  for (const body of [
    { thinking: { type: 'disabled' } }, { thinking: { type: 'enabled', budget_tokens: 2048 } },
    { thinking: { type: 'adaptive', budget_tokens: 2048 } }, { thinking: { type: 'adaptive', display: 'raw' } },
    { output_config: { effort: 'max' } }, { output_config: { effort: 3 } },
    { output_config: { format: { type: 'json_schema' } } }, { thinking: null },
  ]) assert.throws(() => thinkingOptions(body), error => error.status === 400);
});

test('only readable empty-signature thinking history can enter the Chat-compatible path', () => {
  const block = { type: 'thinking', thinking: '可读摘要。', signature: '' };
  assert.equal(thinkingText(block), '可读摘要。');
  assert.deepEqual(block, { type: 'thinking', thinking: '可读摘要。', signature: '' });
  for (const value of [
    { ...block, signature: 'native-signed-state' }, { ...block, signature: null },
    { type: 'redacted_thinking', data: 'sealed-state' }, { ...block, thinking: 1 },
  ]) assert.throws(() => thinkingText(value), error => error.status === 400 && !error.message.includes('native-signed-state'));
});
