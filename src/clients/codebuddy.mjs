import { modelCapabilities } from '../routing/model-capabilities.mjs';

/** CodeBuddy owns its file watcher; Bifrost supplies only its managed entries. */
export const codeBuddyClient = Object.freeze({
  id: 'codebuddy', name: 'CodeBuddy', protocols: ['chat-completions'], query: {},
  catalog(models) { return { data: models.map(model => ({ id: model.id, name: model.name || model.id,
    protocols: [...model.protocols], capabilities: modelCapabilities(model.capabilities) })) }; },
  fileModels(models, { baseUrl, apiKey }) {
    return models.filter(model => model.protocols.includes('chat-completions')).map(model => {
      const caps = modelCapabilities(model.capabilities);
      return { id: model.id, name: model.name || model.id, vendor: 'Bifrost', apiKey,
        url: `${baseUrl}/chat/completions`, maxInputTokens: caps.contextWindow ?? 32000,
        maxOutputTokens: caps.maxOutputTokens ?? 8192,
        supportsToolCall: caps.toolCalls === true || caps.parallelToolCalls === true,
        supportsImages: caps.inputModalities?.includes('image') === true,
        supportsReasoning: Boolean(caps.reasoningEfforts?.some(effort => effort !== 'none')) };
    });
  },
});
