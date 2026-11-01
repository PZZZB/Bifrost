import { modelCapabilities } from './routing/model-capabilities.mjs';

/** The same public, identity-free catalog serves discovery and client adapters. */
export function publicClientModel(model) {
  const caps = model.capabilities ?? {}, known = modelCapabilities(caps);
  if (caps.contextWindow?.support === true && Number.isSafeInteger(caps.contextWindow.tokens)) known.contextWindow = caps.contextWindow.tokens;
  if (caps.images?.support === true || caps.images?.adapterSupport === true) known.inputModalities = ['text', 'image'];
  if (caps.tools?.support === true || caps.tools?.adapterSupport === true) known.toolCalls = true;
  if (caps.reasoning?.support === true && Array.isArray(caps.reasoning.efforts)) known.reasoningEfforts = caps.reasoning.efforts;
  return { id: model.id, object: 'model', owned_by: 'bifrost', name: model.name || model.id,
    protocols: (model.protocols ?? ['responses', 'chat-completions', 'messages']).filter(p => ['responses', 'chat-completions', 'messages'].includes(p)),
    capabilities: modelCapabilities(known) };
}
