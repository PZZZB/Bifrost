const DEFAULTS = Object.freeze({
  'codex-client': { prefix: '', order: 0 },
  codex: { prefix: 'Codex B', order: 100 },
  codebuddy: { prefix: 'CodeBuddy', order: 200 },
  cursor: { prefix: 'Cursor', order: 300 },
  claude: { prefix: 'Claude', order: 400 },
  with: { prefix: 'With', order: 500 },
  bifrost: { prefix: 'Bifröst', order: 600 },
});
const channelKinds = { A: 'codex-client', B: 'codex', CodeBuddy: 'codebuddy', Cursor: 'cursor', Claude: 'claude', With: 'with', Bifrost: 'bifrost' };
const label = value => typeof value === 'string' && value.trim() ? value.trim() : null;

export function modelPresentationFor(account) {
  const defaults = DEFAULTS[account?.kind] ?? { prefix: '', order: 900 };
  return { ...defaults, ...account?.modelPresentation, defaultPrefix: defaults.prefix, defaultOrder: defaults.order };
}

/** Remove only wrappers previously added by this bridge; keep model-family names. */
export function originalModelName(model, channel = model.channel) {
  const original = label(model.originalName);
  if (original) return original;
  let name = label(model.display_name) ?? label(model.name) ?? label(model.displayName) ?? label(model.slug) ?? label(model.id) ?? 'Model';
  if (channel === 'B') name = name.replace(/^B-/i, '');
  else if (channel === 'CodeBuddy') name = name.replace(/^CodeBuddy(?:\s*[·:：-]\s*|\s+)/i, '');
  else if (channel === 'Cursor') name = name.replace(/^Cursor(?:\s*[·:：-]\s*|\s+)/i, '');
  else if (channel === 'Bifrost') name = name.replace(/^远端\s*·\s*Bifrost\s*·\s*/i, '');
  else if (channel === 'With') name = name.replace(/^With\s*·\s*/i, '');
  return name || label(model.id) || 'Model';
}

// The strictest local client limits a model's display name to 256 UTF-16 units.
// Keep every catalog and preview consistent without cutting a surrogate pair.
export function modelDisplayName(prefix, original) {
  const name = prefix ? `${prefix} · ${original}` : original;
  return name.length <= 256 ? name : name.slice(0, 255).replace(/[\uD800-\uDBFF]$/u, '') + '…';
}

/** A presentation change never changes routing IDs, instructions or entitlement. */
export function presentModels(models, { accounts = [], accountFor = () => null, codex = false, channelFor = model => model.channel } = {}) {
  const order = new Map(accounts.map((account, index) => [account.id, index]));
  const groups = new Map();
  const rows = models.map((model, index) => {
    const channel = channelFor(model) ?? 'A', id = model.slug ?? model.id;
    const account = accountFor(channel, id);
    const settings = modelPresentationFor(account ?? { kind: channelKinds[channel] });
    const source = account?.id ?? `channel:${channel}`;
    if (!groups.has(source)) groups.set(source, groups.size);
    const base = originalModelName(model, channel);
    const name = modelDisplayName(settings.prefix, base);
    const value = codex ? { ...model, display_name: name } : { ...model, name, originalName: base };
    return { value, index, native: channel === 'A', source, sourceOrder: settings.order,
      group: order.get(source) ?? accounts.length + groups.get(source), priority: Number.isFinite(model.priority) ? model.priority : index };
  });
  rows.sort((a, b) => Number(b.native) - Number(a.native) || a.sourceOrder - b.sourceOrder || a.group - b.group
    || a.priority - b.priority || a.index - b.index);
  // Each group occupies one continuous priority range. Remote catalog priorities
  // start at zero and must never compete with the native provider's priorities.
  return rows.map((row, priority) => codex ? { ...row.value, priority } : row.value);
}
