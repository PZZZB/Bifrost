import { BridgeError } from './storage.mjs';

export const B_MODELS = [
  { id: 'B-gpt-6-astra', name: 'B-GPT-6 Astra', upstream: 'gpt-6-astra' },
  { id: 'B-gpt-6.1-sol', name: 'B-GPT-6.1 Sol', upstream: 'gpt-6.1-sol' },
];

export function resolveBModel(model) {
  return B_MODELS.find(({ id }) => id === model) ?? null;
}

function requireCatalog(data, account) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.models)) {
    throw new BridgeError(`账户 ${account} 未返回有效的 Codex 模型目录。`, 502, 'invalid_model_catalog');
  }
}

export function mergeCatalog(aData, bData) {
  requireCatalog(aData, 'A');
  requireCatalog(bData, 'B');

  for (const { id } of B_MODELS) {
    if (aData.models.some((model) => model?.slug === id || model?.id === id)) {
      throw new BridgeError(`账户 A 的模型目录包含保留别名 ${id}，无法安全合并。`, 409, 'model_alias_conflict');
    }
  }

  const lastPriority = aData.models.reduce((maximum, model) => (
    typeof model?.priority === 'number' && Number.isFinite(model.priority)
      ? Math.max(maximum, model.priority)
      : maximum
  ), aData.models.length - 1);

  const aliases = B_MODELS.map(({ id, name, upstream }, index) => {
    const source = bData.models.find((model) => model?.slug === upstream);
    if (!source) {
      throw new BridgeError(`账户 B 的模型目录缺少 ${upstream}，无法添加 ${id}。`, 502, 'model_catalog_missing');
    }
    return {
      ...structuredClone(source),
      slug: id,
      display_name: name,
      visibility: 'list',
      upgrade: null,
      priority: lastPriority + index + 1,
      supported_in_api: true,
    };
  });

  const merged = structuredClone(aData);
  merged.models.push(...aliases);
  return merged;
}
