import { ClientRegistry } from './registry.mjs';
import { codexClient } from './codex.mjs';

export const createClientRegistry = () => new ClientRegistry([codexClient]);
