import { modelCapabilities } from './routing/model-capabilities.mjs';
import { contextDeclaration } from './model-context.mjs';

/** The same public, identity-free catalog serves discovery and client adapters. */
export function publicClientModel(model) {
  const caps = model.capabilities ?? {}, known = modelCapabilities(caps);
  if (caps.contextWindow?.support === true && Number.isSafeInteger(caps.contextWindow.tokens)) {
    known.contextWindow = caps.contextWindow.tokens;
  }
  if (Number.isSafeInteger(caps.contextWindow?.maxTokens)) known.maxInputTokens = caps.contextWindow.maxTokens;
  if (Array.isArray(caps.contextWindow?.options) && caps.contextWindow.options.length) known.contextWindowOptions = caps.contextWindow.options;
  if (Number.isSafeInteger(caps.contextWindow?.clientTokens)) known.clientContextWindow = caps.contextWindow.clientTokens;
  if (model.contextSettings?.valid === true && model.contextSettings.selectedTokens !== null
    && Number.isSafeInteger(model.contextSettings.effectiveTokens)) known.clientContextWindow = model.contextSettings.effectiveTokens;
  if (caps.images?.support === true || caps.images?.adapterSupport === true) known.inputModalities = ['text', 'image'];
  if (caps.tools?.support === true || caps.tools?.adapterSupport === true) known.toolCalls = true;
  if (caps.reasoning?.support === true && Array.isArray(caps.reasoning.efforts)) known.reasoningEfforts = caps.reasoning.efforts;
  const published = modelCapabilities(known), context = contextDeclaration(published);
  if (published.contextWindow !== undefined) published.contextWindow = context.tokens;
  if (published.contextWindowOptions !== undefined) published.contextWindowOptions = context.options;
  if (published.clientContextWindow !== undefined) published.clientContextWindow = context.clientTokens;
  return { id: model.id, object: 'model', owned_by: 'bifrost', name: model.name || model.id,
    protocols: (model.protocols ?? ['responses', 'chat-completions', 'messages']).filter(p => ['responses', 'chat-completions', 'messages'].includes(p)),
    capabilities: published };
}
