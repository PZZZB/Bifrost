import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ForkLineage } from '../src/fork-lineage.mjs';

const secret = 'private-fork-index-fixture-secret-'.repeat(3);
const owner = 'private-client-owner-one', otherOwner = 'private-client-owner-two';
const uuid = number => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const a = uuid(1), b = uuid(2), c = uuid(3), d = uuid(4), e = uuid(5);
const hasCode = code => error => error.code === code;

function within(directory, path) {
  const target = resolve(path), local = relative(directory, target);
  assert.ok(local && !local.startsWith('..') && !isAbsolute(local), 'Fixture operations must remain in their temporary directory.');
  return target;
}

async function fixture(t, options = {}) {
  const directory = resolve(await mkdtemp(join(tmpdir(), 'bifrost-fork-lineage-')));
  const checkRoot = () => {
    assert.equal(dirname(directory).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.ok(basename(directory).startsWith('bifrost-fork-lineage-'));
  };
  checkRoot();
  t.after(async () => { checkRoot(); await rm(directory, { recursive: true, force: true }); });
  const path = within(directory, join(directory, 'lineage.json'));
  return { directory, path, index: await ForkLineage.open({ path, secret, ...options }) };
}

test('missing indexes leave explicit candidates usable and reject invalid owner or thread identifiers', async t => {
  const { path, index } = await fixture(t);
  assert.deepEqual(index.status(), { available: true, entries: 0, error: null });
  assert.deepEqual(index.candidates({ owner, session: b, parentSession: a, familySession: a }), [b, a]);
  assert.deepEqual(index.candidates({ owner, session: b.toUpperCase(), parentSession: a.toUpperCase() }), [b, a]);
  await assert.rejects(access(path), error => error.code === 'ENOENT');
  for (const fields of [{ owner: '' }, { owner: 'owner\n' }, { owner: 'x'.repeat(129) },
    { session: '../state' }, { session: null }, { parentSession: [] }, { familySession: 'bad' }]) {
    assert.throws(() => index.candidates({ owner, session: a, ...fields }), hasCode('fork_lineage_invalid'));
  }
  await assert.rejects(index.remember({ owner, session: a }), hasCode('fork_lineage_invalid'));
  assert.equal(index.status().entries, 0);
});

test('owners and signing secrets isolate persisted ancestors without storing account names or private data', async t => {
  const { path, index } = await fixture(t);
  await index.remember({ owner, session: c, parentSession: a });
  await index.remember({ owner: otherOwner, session: c, parentSession: b });
  assert.deepEqual(index.candidates({ owner, session: c }), [c, a]);
  assert.deepEqual(index.candidates({ owner: otherOwner, session: c }), [c, b]);
  assert.deepEqual(index.candidates({ owner: 'third-owner', session: c }), [c]);
  const raw = await readFile(path, 'utf8'), data = JSON.parse(raw);
  assert.deepEqual(Object.keys(data).sort(), ['entries', 'version']);
  assert.equal(data.version, 1); assert.equal(data.entries.length, 2);
  for (const row of data.entries) {
    assert.deepEqual(Object.keys(row).sort(), ['child', 'ownerHash', 'parent']);
    assert.match(row.ownerHash, /^[a-f0-9]{64}$/);
  }
  for (const text of [secret, owner, otherOwner, 'apiKey', 'message', 'token']) assert.equal(raw.includes(text), false);
  const changedSecret = await ForkLineage.open({ path, secret: 'another-fork-index-secret-'.repeat(3) });
  assert.deepEqual(changedSecret.candidates({ owner, session: c }), [c]);
  const reopened = await ForkLineage.open({ path, secret });
  assert.deepEqual(reopened.candidates({ owner, session: c }), [c, a]);
  assert.deepEqual(reopened.candidates({ owner: otherOwner, session: c }), [c, b]);
});

test('nested forks retain all known ancestors after restart and may start from an explicit parent hint', async t => {
  const { path, index } = await fixture(t);
  await index.remember({ owner, session: b, parentSession: a });
  await index.remember({ owner, session: c, parentSession: b });
  const reopened = await ForkLineage.open({ path, secret });
  assert.deepEqual(reopened.candidates({ owner, session: c }), [c, b, a]);
  assert.deepEqual(reopened.candidates({ owner, session: d, parentSession: c, familySession: a }), [d, c, a, b]);
  const result = reopened.candidates({ owner, session: c }); result.push(e);
  assert.deepEqual(reopened.candidates({ owner, session: c }), [c, b, a]);
});

test('serialized writes copy caller inputs and keep concurrent owners and descendants', async t => {
  const { path, index } = await fixture(t);
  const input = { owner, session: b, parentSession: a };
  const first = index.remember(input);
  input.owner = 'changed-owner'; input.parentSession = d;
  await Promise.all([first, index.remember({ owner, session: c, parentSession: b }),
    index.remember({ owner: otherOwner, session: c, parentSession: d })]);
  assert.equal(await index.remember({ owner, session: b, parentSession: a }), false);
  const reopened = await ForkLineage.open({ path, secret });
  assert.equal(reopened.status().entries, 3);
  assert.deepEqual(reopened.candidates({ owner, session: c }), [c, b, a]);
  assert.deepEqual(reopened.candidates({ owner: otherOwner, session: c }), [c, d]);
  assert.deepEqual(reopened.candidates({ owner: 'changed-owner', session: b }), [b]);
});

test('parent conflicts and cycles cannot overwrite existing relations or poison subsequent writes', async t => {
  const { path, index } = await fixture(t);
  await index.remember({ owner, session: b, parentSession: a });
  await index.remember({ owner, session: c, parentSession: b });
  const saved = await readFile(path, 'utf8');
  for (const pair of [[b, d], [a, c], [d, d]]) {
    await assert.rejects(index.remember({ owner, session: pair[0], parentSession: pair[1] }), hasCode('fork_lineage_conflict'));
    assert.equal(await readFile(path, 'utf8'), saved);
  }
  assert.deepEqual(index.candidates({ owner, session: c }), [c, b, a]);
  await index.remember({ owner, session: d, parentSession: c });
  assert.deepEqual(index.candidates({ owner, session: d }), [d, c, b, a]);
});

test('bounded storage retains recent entries across owners and bounds ancestor enumeration', async t => {
  const { path, index } = await fixture(t, { maxEntries: 2 });
  await index.remember({ owner, session: b, parentSession: a });
  await index.remember({ owner: otherOwner, session: c, parentSession: a });
  await index.remember({ owner, session: d, parentSession: b });
  assert.equal(index.status().entries, 2);
  assert.deepEqual(index.candidates({ owner, session: d }), [d, b]);
  assert.deepEqual(index.candidates({ owner: otherOwner, session: c }), [c, a]);
  const rows = JSON.parse(await readFile(path, 'utf8')).entries;
  const ownerHash = rows.find(row => row.child === d).ownerHash;
  await writeFile(path, JSON.stringify({ version: 1, entries: Array.from({ length: 100 }, (_, n) =>
    ({ ownerHash, child: uuid(n + 2), parent: uuid(n + 1) })) }));
  const deep = await ForkLineage.open({ path, secret });
  const candidates = deep.candidates({ owner, session: uuid(101), parentSession: uuid(100), familySession: uuid(1) });
  assert.equal(candidates.length, 64); assert.equal(new Set(candidates).size, 64);
  assert.deepEqual(candidates.slice(0, 4), [uuid(101), uuid(100), uuid(1), uuid(99)]);
});

test('corrupt, oversized or cyclic indexes fail closed without blocking explicit new-session candidates', async t => {
  const { path, index } = await fixture(t);
  await index.remember({ owner, session: b, parentSession: a });
  const row = JSON.parse(await readFile(path, 'utf8')).entries[0];
  const malformed = [
    '{', JSON.stringify({ version: 2, entries: [row] }),
    JSON.stringify({ version: 1, entries: [row, row] }),
    JSON.stringify({ version: 1, entries: [{ ...row, child: 'invalid' }] }),
    JSON.stringify({ version: 1, entries: [{ ...row, extra: 'not-a-lineage-field' }] }),
    JSON.stringify({ version: 1, entries: [row, { ...row, child: a, parent: b }] }),
    Buffer.from([0xff, 0xfe]), ' '.repeat(2 * 1024 * 1024 + 1),
  ];
  for (const raw of malformed) {
    await writeFile(path, raw);
    const broken = await ForkLineage.open({ path, secret });
    assert.deepEqual(broken.status(), { available: false, entries: 0,
      error: { code: 'fork_lineage_unavailable', message: '已保存的聊天分叉关系不可读取。' } });
    assert.deepEqual(broken.candidates({ owner, session: c, parentSession: b, familySession: a }), [c, b, a]);
    await assert.rejects(broken.remember({ owner, session: c, parentSession: b }), hasCode('fork_lineage_unavailable'));
    assert.deepEqual(await readFile(path), Buffer.from(raw));
  }
});

test('a failed atomic replacement retains known ancestors and later writes can recover', async t => {
  const { directory, path, index } = await fixture(t);
  await index.remember({ owner, session: b, parentSession: a });
  const saved = within(directory, join(directory, 'previous.json'));
  await rename(within(directory, path), saved);
  await mkdir(within(directory, path));
  await assert.rejects(index.remember({ owner, session: c, parentSession: b }), hasCode('fork_lineage_write_failed'));
  assert.equal(index.status().available, true); assert.equal(index.status().entries, 1);
  assert.equal(index.status().error.code, 'fork_lineage_write_failed');
  assert.deepEqual(index.candidates({ owner, session: c }), [c]);
  assert.deepEqual(index.candidates({ owner, session: b }), [b, a]);
  assert.deepEqual((await readdir(directory)).sort(), ['lineage.json', 'previous.json']);
  await rm(within(directory, path), { recursive: true });
  await rename(saved, within(directory, path));
  await index.remember({ owner, session: c, parentSession: b });
  assert.equal(index.status().error, null);
  const reopened = await ForkLineage.open({ path, secret });
  assert.deepEqual(reopened.candidates({ owner, session: c }), [c, b, a]);
});

test('configuration bounds and directory indexes are rejected without creating unrelated files', async t => {
  const { directory, path } = await fixture(t);
  for (const options of [{ path: 'relative.json' }, { path: path + '\0suffix' }, { secret: '' },
    { maxEntries: 0 }, { maxEntries: 8193 }, { maxEntries: 1.5 }]) {
    await assert.rejects(ForkLineage.open({ path, secret, ...options }), TypeError);
  }
  const missing = within(directory, join(directory, 'new', 'lineage.json'));
  const nested = await ForkLineage.open({ path: missing, secret });
  await nested.remember({ owner, session: b, parentSession: a });
  assert.equal(JSON.parse(await readFile(missing, 'utf8')).entries.length, 1);
  const wrongType = await ForkLineage.open({ path: directory, secret });
  assert.equal(wrongType.status().available, false);
  assert.deepEqual(wrongType.candidates({ owner, session: a }), [a]);
});
