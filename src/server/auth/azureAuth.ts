import type { AuthConfig } from '../config.js';

export const COGNITIVE_SERVICES_SCOPE = 'https://cognitiveservices.azure.com/.default';

/** Supplies authentication headers for an upstream request; secrets never leave this module's output headers. */
export interface AuthProvider {
  readonly mode: AuthConfig['mode'];
  headers(): Promise<Record<string, string>>;
}

export function staticHeaderAuth(headerName: string, value: string): AuthProvider {
  return {
    mode: 'credential',
    headers: async () => ({ [headerName]: value }),
  };
}

interface TokenCredentialLike {
  getToken(scope: string): Promise<{ token: string } | null>;
}

let sharedCredential: Promise<TokenCredentialLike> | undefined;

async function defaultCredential(): Promise<TokenCredentialLike> {
  sharedCredential ??= import('@azure/identity').then(({ DefaultAzureCredential }) => new DefaultAzureCredential());
  return sharedCredential;
}

export function identityAuth(credential?: TokenCredentialLike): AuthProvider {
  return {
    mode: 'platform-identity',
    headers: async () => {
      const cred = credential ?? (await defaultCredential());
      const token = await cred.getToken(COGNITIVE_SERVICES_SCOPE);
      if (!token) throw new Error('managed identity token unavailable');
      return { Authorization: `Bearer ${token.token}` };
    },
  };
}

export function speechAuth(config: AuthConfig): AuthProvider {
  return config.mode === 'credential' ? staticHeaderAuth('Ocp-Apim-Subscription-Key', config.key) : identityAuth();
}

export function chatAuth(config: AuthConfig): AuthProvider {
  return config.mode === 'credential' ? staticHeaderAuth('api-key', config.key) : identityAuth();
}
