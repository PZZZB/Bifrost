import { ClientRegistry } from './registry.mjs';
import { codexClient } from './codex.mjs';
import { codeBuddyClient } from './codebuddy.mjs';

export const createClientRegistry = () => new ClientRegistry([codexClient, codeBuddyClient]);
