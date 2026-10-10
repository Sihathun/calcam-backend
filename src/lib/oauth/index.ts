import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Config } from '../../config/env';
import { AppError, unauthorized } from '../errors';

export type OAuthProvider = 'apple' | 'google';

export interface OAuthIdentity {
  sub: string;
  email?: string;
  emailVerified: boolean;
  /** Display name from the provider's profile, when the token carries one. */
  name?: string;
  /** https URL of the provider's profile photo, when the token carries one. */
  pictureUrl?: string;
}

export interface OAuthVerifier {
  verify(provider: OAuthProvider, idToken: string, nonce?: string): Promise<OAuthIdentity>;
}

const GOOGLE_JWKS = new URL('https://www.googleapis.com/oauth2/v3/certs');
const APPLE_JWKS = new URL('https://appleid.apple.com/auth/keys');

/** Verifies Apple and Google ID tokens against their published signing keys. */
export class JoseOAuthVerifier implements OAuthVerifier {
  private readonly google = createRemoteJWKSet(GOOGLE_JWKS);
  private readonly apple = createRemoteJWKSet(APPLE_JWKS);

  constructor(private readonly config: Config) {}

  async verify(provider: OAuthProvider, idToken: string, nonce?: string): Promise<OAuthIdentity> {
    const audience = provider === 'google' ? this.config.oauth.googleClientIds : this.config.oauth.appleClientIds;
    if (!audience.length) {
      throw new AppError(503, 'OAUTH_NOT_CONFIGURED', `${provider} sign-in is not configured on this server`);
    }

    let payload;
    try {
      const result =
        provider === 'google'
          ? await jwtVerify(idToken, this.google, {
              issuer: ['https://accounts.google.com', 'accounts.google.com'],
              audience,
            })
          : await jwtVerify(idToken, this.apple, { issuer: 'https://appleid.apple.com', audience });
      payload = result.payload;
    } catch {
      throw unauthorized('INVALID_ID_TOKEN', 'The identity token could not be verified');
    }

    if (nonce) {
      // Clients may send the raw nonce or its SHA-256 hex digest in the token.
      const hashed = createHash('sha256').update(nonce).digest('hex');
      if (payload['nonce'] !== nonce && payload['nonce'] !== hashed) {
        throw unauthorized('INVALID_ID_TOKEN', 'The identity token nonce does not match');
      }
    }
    if (!payload.sub) throw unauthorized('INVALID_ID_TOKEN', 'The identity token has no subject');

    const verified = payload['email_verified'];
    const name = typeof payload['name'] === 'string' ? payload['name'].trim().slice(0, 100) : '';
    const picture = typeof payload['picture'] === 'string' ? payload['picture'] : '';
    return {
      sub: payload.sub,
      email: typeof payload['email'] === 'string' ? payload['email'].toLowerCase() : undefined,
      emailVerified: verified === true || verified === 'true',
      name: name || undefined,
      pictureUrl: picture.startsWith('https://') && picture.length <= 500 ? picture : undefined,
    };
  }
}
