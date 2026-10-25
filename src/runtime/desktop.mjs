import { join } from 'node:path';
import { once } from 'node:events';
import { startCodeBuddyService } from '../codebuddy-service.mjs';
import { CodeBuddyLocal } from '../providers/codebuddy-local.mjs';
import { BifrostRemote } from '../providers/bifrost-remote.mjs';
import { ModelRouter } from '../routing/model-router.mjs';
import { createDesktopServer } from './desktop-server.mjs';
import { loadDesktopConfig, loadDesktopIdentity, desktopCredentialStore, validateDesktopConfig } from './desktop-config.mjs';

/** Assemble only selected sources. Never boots Codex RPC, VM, tunnels or Server accounts. */
export async function startDesktop({ stateDir, config: suppliedConfig, identity: suppliedIdentity,
  startLocalService = startCodeBuddyService,
  loadRemoteKey = async id => (await desktopCredentialStore(stateDir, `remote-${id}`).load())?.apiKey,
  fetchImpl = fetch } = {}) {
  const config = suppliedConfig ? validateDesktopConfig(suppliedConfig) : await loadDesktopConfig(stateDir);
  const identity = suppliedIdentity ?? await loadDesktopIdentity(stateDir);
  const providers = [];
  let router, server, timer;
  try {
    for (const source of config.sources) {
      if (source.kind === 'codebuddy-local') {
        const service = await startLocalService({ stateDir: join(stateDir, 'sources', source.id), retryUnauthorizedInference: false });
        providers.push(new CodeBuddyLocal({ id: source.id, service }));
      } else {
        // This branch is not evaluated and the credential file is never opened in local-only mode.
        providers.push(new BifrostRemote({ ...source, apiKey: await loadRemoteKey(source.id), fetchImpl }));
      }
    }
    router = new ModelRouter({ providers, secret: identity.secret });
    server = createDesktopServer({ router, apiKey: identity.apiKey, stateSecret: identity.secret });
    server.listen(config.port, '127.0.0.1'); await once(server, 'listening');
    // Independent background snapshots. Starting and local inference never wait for Mac.
    void router.refresh();
    timer = setInterval(() => { void router.refresh(); }, 15_000); timer.unref();
    let closing;
    return { router, server, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      close() {
        if (closing) return closing;
        closing = (async () => {
          clearInterval(timer); server.stopRequests();
          const stopped = new Promise(resolve => server.close(resolve)); server.closeAllConnections();
          await router.close(); await stopped;
        })();
        return closing;
      } };
  } catch (error) {
    clearInterval(timer); server?.close(); server?.closeAllConnections();
    await Promise.allSettled(providers.map(provider => provider.close()));
    throw error;
  }
}
