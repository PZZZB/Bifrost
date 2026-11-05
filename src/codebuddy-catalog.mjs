import { join } from 'node:path';

const EXTENSION = 'Tencent-Cloud.coding-copilot';
const CACHE = '$.cloud_product_config_cache';
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const MAX_MODELS = 512;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:[\]/-]{0,255}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 2048) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

export class NativeCatalogError extends Error {
  constructor(code = 'native_catalog_unavailable') { super('CodeBuddy 本机模型目录暂不可用。'); this.code = code; }
}

function assertActive(signal) {
  if (signal?.aborted) throw new NativeCatalogError('aborted');
}

// SQL projects only model metadata. It never returns the extension state,
// authentication records, model apiKey fields, or custom provider headers.
const ownedEntry = `FROM ItemTable AS state,
  json_each(json_extract(state.value, '${CACHE}')) AS cache
  WHERE state.key = ? AND json_extract(cache.value, '$.userId') = ?`;
const metadataSql = `SELECT json_extract(cache.value, '$.ts') AS savedAt,
  json_type(cache.value, '$.data.models') AS modelType,
  json_array_length(json_extract(cache.value, '$.data.models')) AS modelCount
  ${ownedEntry}`;
const selectedEntry = `WITH owned AS (
  SELECT cache.value AS entry ${ownedEntry}
  AND json_extract(cache.value, '$.ts') = ?
)`;
const modelFields = ['id', 'name', 'credits', 'disabled', 'available', 'enabled',
  'supportsToolCall', 'supportsImages', 'disabledMultimodal', 'supportsReasoning', 'maxInputTokens', 'maxOutputTokens'];
const modelSql = `${selectedEntry}
  SELECT ${modelFields.flatMap(field => [
    `CASE WHEN json_type(model.value, '$.${field}') IN ('text','integer','real','true','false')
      THEN json_extract(model.value, '$.${field}') END AS ${field}`,
    `json_type(model.value, '$.${field}') AS ${field}Type`,
  ]).join(', ')},
  CASE WHEN json_type(model.value, '$.error') NOT IN ('null','false')
    AND coalesce(json_extract(model.value, '$.error'), '') != '' THEN 1 ELSE 0 END AS hasError,
  CASE WHEN json_type(model.value, '$.disabledReason') NOT IN ('null','false')
    AND coalesce(json_extract(model.value, '$.disabledReason'), '') != '' THEN 1 ELSE 0 END AS hasDisabledReason,
  CASE WHEN json_type(model.value, '$.reasoning.supportedEfforts') = 'array'
    AND json_array_length(model.value, '$.reasoning.supportedEfforts') <= 32
    THEN (SELECT json_group_array(effort.value) FROM json_each(model.value, '$.reasoning.supportedEfforts') AS effort
      WHERE effort.type = 'text' AND length(effort.value) <= 64) END AS reasoningEfforts,
  CASE WHEN json_type(model.value, '$.reasoning.defaultEffort') = 'text'
    THEN json_extract(model.value, '$.reasoning.defaultEffort') END AS defaultEffort,
  CASE WHEN json_extract(model.value, '$.reasoning.summary') = 'auto' THEN 'auto' END AS reasoningSummary,
  CASE WHEN json_type(model.value, '$.reasoning.canDisableThinking') IN ('true','false')
    THEN json_extract(model.value, '$.reasoning.canDisableThinking') END AS canDisableThinking,
  CASE WHEN json_type(model.value, '$.contextWindow.defaultLength') = 'integer'
    THEN json_extract(model.value, '$.contextWindow.defaultLength') END AS contextLength,
  CASE WHEN json_type(model.value, '$.contextWindow.supportedLengths') = 'array'
    AND json_array_length(model.value, '$.contextWindow.supportedLengths') BETWEEN 1 AND 32
    AND NOT EXISTS (SELECT 1 FROM json_each(model.value, '$.contextWindow.supportedLengths') AS length
      WHERE length.type != 'integer' OR length.value < 1 OR length.value > 1000000000)
    THEN (SELECT json_group_array(length.value) FROM json_each(model.value, '$.contextWindow.supportedLengths') AS length)
    END AS contextLengths
  FROM owned, json_each(json_extract(owned.entry, '$.data.models')) AS model
  LIMIT ${MAX_MODELS + 1}`;
const promotionFields = ['id', 'name', 'priority', 'enabled', 'startAt', 'endAt', 'startTime', 'endTime'];
const promotionSql = `${selectedEntry}
  SELECT ${promotionFields.map(field =>
    `CASE WHEN json_type(promotion.value, '$.${field}') IN ('text','integer','real','true','false')
      THEN json_extract(promotion.value, '$.${field}') END AS ${field}`).join(', ')},
  json_type(promotion.value, '$.enabled') AS enabledType,
  CASE WHEN json_type(promotion.value, '$.discount.discountedCredits') IN ('text','integer','real')
    THEN json_extract(promotion.value, '$.discount.discountedCredits') END AS discountedCredits,
  CASE WHEN json_type(promotion.value, '$.discount.factor') IN ('integer','real')
    THEN json_extract(promotion.value, '$.discount.factor') END AS factor
  FROM owned, json_each(json_extract(owned.entry, '$.data.modelPromotions')) AS promotion
  WHERE EXISTS (SELECT 1 FROM json_each(json_extract(promotion.value, '$.modelIds')) AS target WHERE target.value = ?)
  LIMIT 17`;

function scalar(value, max = 2048) {
  return text(value, max) || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean'
    ? value : undefined;
}

function promotionMetadata(row) {
  const result = {};
  for (const field of promotionFields) {
    const value = field === 'enabled' ? row.enabledType === 'true' ? true : row.enabledType === 'false' ? false : undefined
      : scalar(row[field]);
    if (value !== undefined) result[field] = value;
  }
  const discountedCredits = scalar(row.discountedCredits, 256), factor = scalar(row.factor, 256);
  if (discountedCredits !== undefined || factor !== undefined) result.discount = {
    ...(discountedCredits !== undefined ? { discountedCredits } : {}),
    ...(factor !== undefined ? { factor } : {}),
  };
  return result;
}

/** Read the same account's native catalog metadata; never read native credentials. */
export class NativeCodeBuddyCatalog {
  constructor({ databasePath = process.env.APPDATA
    ? join(process.env.APPDATA, 'CodeBuddy CN', 'User', 'globalStorage', 'state.vscdb') : null,
  now = Date.now, maxAgeMs = MAX_AGE } = {}) {
    if (databasePath !== null && !text(databasePath, 32768) || typeof now !== 'function' ||
        !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) throw new TypeError('Invalid native catalog settings.');
    this.databasePath = databasePath; this.now = now; this.maxAgeMs = maxAgeMs;
  }

  async load({ identity, signal } = {}) {
    assertActive(signal);
    if (!object(identity) || !text(identity.uid, 256) || !identity.uid || !this.databasePath) throw new NativeCatalogError();
    let database;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      assertActive(signal);
      database = new DatabaseSync(this.databasePath, { readOnly: true });
      database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
      const entries = database.prepare(metadataSql).all(EXTENSION, identity.uid);
      if (entries.length !== 1) throw new NativeCatalogError('native_catalog_owner_missing');
      const entry = entries[0], now = this.now();
      if (!Number.isSafeInteger(entry.savedAt) || entry.savedAt <= 0 || entry.savedAt > now + 300000 ||
          now - entry.savedAt >= this.maxAgeMs) throw new NativeCatalogError('native_catalog_expired');
      if (entry.modelType !== 'array' || !Number.isInteger(entry.modelCount) ||
          entry.modelCount < 1 || entry.modelCount > MAX_MODELS) throw new NativeCatalogError('invalid_native_catalog');
      const rows = database.prepare(modelSql).all(EXTENSION, identity.uid, entry.savedAt);
      if (rows.length !== entry.modelCount) throw new NativeCatalogError('invalid_native_catalog');
      const models = rows.map(row => {
        if (row.idType !== 'text' || !idPattern.test(row.id) || row.nameType !== 'text' || !text(row.name, 256)) {
          throw new NativeCatalogError('invalid_native_catalog');
        }
        const model = { id: row.id, name: row.name };
        const credits = scalar(row.credits, 256);
        if (credits !== undefined) model.credits = credits;
        for (const field of ['disabled', 'available', 'enabled']) {
          const type = row[`${field}Type`];
          if (type !== null && !['null', 'true', 'false'].includes(type)) throw new NativeCatalogError('invalid_native_catalog');
          if (type === 'true' || type === 'false') model[field] = type === 'true';
        }
        for (const field of ['supportsToolCall', 'supportsImages', 'disabledMultimodal', 'supportsReasoning']) {
          if (row[`${field}Type`] === 'true' || row[`${field}Type`] === 'false') model[field] = row[`${field}Type`] === 'true';
        }
        for (const field of ['maxInputTokens', 'maxOutputTokens']) {
          if (Number.isSafeInteger(row[field]) && row[field] > 0 && row[field] <= 1_000_000_000) model[field] = row[field];
        }
        const reasoning = {};
        if (row.reasoningEfforts !== null) {
          const values = JSON.parse(row.reasoningEfforts);
          if (values.every(value => /^[A-Za-z0-9_-]{1,64}$/.test(value))) reasoning.supportedEfforts = values;
        }
        if (text(row.defaultEffort, 64) && /^[A-Za-z0-9_-]{1,64}$/.test(row.defaultEffort)) reasoning.defaultEffort = row.defaultEffort;
        if (row.reasoningSummary === 'auto') reasoning.summary = 'auto';
        if (row.canDisableThinking === 0 || row.canDisableThinking === 1) reasoning.canDisableThinking = row.canDisableThinking === 1;
        if (Object.keys(reasoning).length) model.reasoning = reasoning;
        const contextWindow = {};
        if (Number.isSafeInteger(row.contextLength) && row.contextLength > 0 && row.contextLength <= 1_000_000_000) {
          contextWindow.defaultLength = row.contextLength;
        }
        if (row.contextLengths !== null) {
          contextWindow.supportedLengths = [...new Set(JSON.parse(row.contextLengths))].sort((a, b) => a - b);
        }
        if (Object.keys(contextWindow).length) model.contextWindow = contextWindow;
        if (row.hasError) model.error = true;
        if (row.hasDisabledReason) model.disabledReason = true;
        const promotions = database.prepare(promotionSql).all(EXTENSION, identity.uid, entry.savedAt, model.id);
        if (promotions.length > 16) throw new NativeCatalogError('invalid_native_catalog');
        if (promotions.length) model.promotions = promotions.map(promotionMetadata);
        return model;
      });
      assertActive(signal);
      return { models, source: 'native-cache', savedAt: entry.savedAt, liveVerified: false };
    } catch (error) {
      if (error instanceof NativeCatalogError) throw error;
      throw new NativeCatalogError();
    } finally { try { database?.close(); } catch {} }
  }
}
