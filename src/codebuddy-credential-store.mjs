import { CurrentUserCredentialStore } from './current-user-credential-store.mjs';

// Preserve the established DPAPI entropy, file format and public exports.
export { CredentialStoreError as CodeBuddyCredentialError } from './current-user-credential-store.mjs';
export class CodeBuddyCredentialStore extends CurrentUserCredentialStore {
  constructor(options = {}) {
    super({ ...options, namespace: 'CodexAccountBridge.CodeBuddyOAuth.v1' });
  }
}
