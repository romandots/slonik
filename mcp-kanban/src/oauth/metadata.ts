export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
}

export const OAUTH_SCOPE = 'mcp';

function trimSlash(issuer: string): string {
  // Снимаем любое число хвостовых слэшей (defensive: `https://x//` тоже).
  return issuer.replace(/\/+$/, '');
}

/** RFC 9728 — Protected Resource Metadata. */
export function buildProtectedResourceMetadata(issuer: string): ProtectedResourceMetadata {
  const base = trimSlash(issuer);
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: [OAUTH_SCOPE],
  };
}

/** RFC 8414 — Authorization Server Metadata. */
export function buildAuthorizationServerMetadata(issuer: string): AuthorizationServerMetadata {
  const base = trimSlash(issuer);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [OAUTH_SCOPE],
  };
}

/** Canonical resource URI for audience binding (RFC 8707). */
export function resourceUri(issuer: string): string {
  return `${trimSlash(issuer)}/mcp`;
}
