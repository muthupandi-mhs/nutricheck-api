import type { ConfigService } from '@nestjs/config';
import {
  createHmac,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import {
  GoogleIdentityService,
  GoogleTokenInvalid,
  GoogleUnavailable,
} from '../google-identity.service';

/**
 * The token verifier, exercised against real RSA signatures.
 *
 * A keypair is generated here and its public half served as the JWKS, so these
 * are not assertions about a mock — a token that this suite says verifies was
 * genuinely signed, and one it says is rejected genuinely fails a cryptographic
 * check. Anything less would pass just as happily against a verifier that
 * returned true unconditionally, which is the failure mode worth fearing in a
 * file like this.
 *
 * Half of what is below is not testing our code so much as pinning the attacks
 * it must not fall to. `alg: none` and the HS256 confusion are the two ways
 * hand-rolled JWT verification is broken in the wild, and both are cheap to
 * reintroduce with a plausible-looking edit.
 */

const AUDIENCE = '1234-web.apps.googleusercontent.com';
const KID = 'test-key-1';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

/** A second key, never published, for signing tokens nobody should accept. */
const impostor = generateKeyPairSync('rsa', { modulusLength: 2048 });

function base64url(value: object | string): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return Buffer.from(raw).toString('base64url');
}

function jwks(...keys: Array<Record<string, unknown>>) {
  return {
    keys: keys.length
      ? keys
      : [
          {
            ...(publicKey.export({ format: 'jwk' }) as object),
            kid: KID,
            alg: 'RS256',
            use: 'sig',
          },
        ],
  };
}

type Claims = Record<string, unknown>;

function claims(overrides: Claims = {}): Claims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://accounts.google.com',
    aud: AUDIENCE,
    sub: '108000000000000000001',
    email: 'sundar@example.com',
    email_verified: true,
    iat: now - 30,
    exp: now + 3600,
    ...overrides,
  };
}

/** A properly signed RS256 token, unless `key` says otherwise. */
function sign(payload: Claims, header: Record<string, unknown> = {}, key: KeyObject | string = privateKey): string {
  const encodedHeader = base64url({ alg: 'RS256', kid: KID, typ: 'JWT', ...header });
  const encodedPayload = base64url(payload);
  const signature = createSign('RSA-SHA256')
    .update(`${encodedHeader}.${encodedPayload}`)
    .sign(key)
    .toString('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function service(
  audiences: string[] = [AUDIENCE],
  body: unknown = jwks(),
  init: { ok?: boolean; cacheControl?: string | null } = {},
): { subject: GoogleIdentityService; fetches: () => number } {
  let calls = 0;

  global.fetch = (async () => {
    calls += 1;
    return {
      ok: init.ok ?? true,
      status: init.ok === false ? 500 : 200,
      json: async () => body,
      headers: { get: () => init.cacheControl ?? 'public, max-age=21600' },
    };
  }) as unknown as typeof fetch;

  const config = { get: () => audiences } as unknown as ConfigService<never, true>;

  return {
    subject: new GoogleIdentityService(config as never),
    fetches: () => calls,
  };
}

describe('GoogleIdentityService', () => {
  const realFetch = global.fetch;
  afterAll(() => {
    global.fetch = realFetch;
  });

  describe('a token Google actually signed', () => {
    it('verifies and returns the subject and email', async () => {
      const { subject } = service();

      await expect(subject.verify(sign(claims()))).resolves.toEqual({
        subject: '108000000000000000001',
        email: 'sundar@example.com',
        emailVerified: true,
      });
    });

    it('accepts the bare issuer spelling as well as the https one', async () => {
      const { subject } = service();
      const token = sign(claims({ iss: 'accounts.google.com' }));

      await expect(subject.verify(token)).resolves.toMatchObject({
        subject: '108000000000000000001',
      });
    });

    it('lowercases the email, so a Google address and a typed one are one account', async () => {
      const { subject } = service();
      const token = sign(claims({ email: '  Sundar@Example.COM ' }));

      await expect(subject.verify(token)).resolves.toMatchObject({
        email: 'sundar@example.com',
      });
    });
  });

  /**
   * The two classic breaks. Both produce a token that "parses" perfectly and
   * carries whatever claims the attacker chose.
   */
  describe('forged algorithms', () => {
    it('rejects alg: none, however well-formed the rest is', async () => {
      const { subject } = service();
      const header = base64url({ alg: 'none', kid: KID, typ: 'JWT' });
      const payload = base64url(claims());

      await expect(subject.verify(`${header}.${payload}.`)).rejects.toThrow(
        GoogleTokenInvalid,
      );
    });

    it('rejects HS256 signed with the PUBLIC key as the secret', async () => {
      // The whole attack: the verifier is told the algorithm is symmetric, and
      // the key it would use is public, so the attacker can produce the MAC.
      const { subject } = service();
      const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

      const header = base64url({ alg: 'HS256', kid: KID, typ: 'JWT' });
      const payload = base64url(claims());
      const mac = createHmac('sha256', publicPem)
        .update(`${header}.${payload}`)
        .digest('base64url');

      await expect(subject.verify(`${header}.${payload}.${mac}`)).rejects.toThrow(
        GoogleTokenInvalid,
      );
    });

    it('rejects a real RS256 signature from a key Google never published', async () => {
      const { subject } = service();

      await expect(
        subject.verify(sign(claims(), {}, impostor.privateKey)),
      ).rejects.toThrow(GoogleTokenInvalid);
    });

    it('rejects a token whose payload was edited after signing', async () => {
      const { subject } = service();
      const [header, , signature] = sign(claims()).split('.');
      const swapped = base64url(claims({ sub: 'somebody-else' }));

      await expect(
        subject.verify(`${header}.${swapped}.${signature}`),
      ).rejects.toThrow(GoogleTokenInvalid);
    });
  });

  describe('claims', () => {
    /**
     * The check that stops every other app on the internet from being able to
     * sign its users into this one. A token from another Google client is
     * genuine, correctly signed, and unexpired — `aud` is the only thing that
     * distinguishes it.
     */
    it('rejects a genuine token minted for a different client', async () => {
      const { subject } = service();
      const token = sign(claims({ aud: 'someone-elses-app.apps.googleusercontent.com' }));

      await expect(subject.verify(token)).rejects.toThrow(GoogleTokenInvalid);
    });

    it('rejects an aud array, which an ID token does not have', async () => {
      const { subject } = service();

      await expect(subject.verify(sign(claims({ aud: [AUDIENCE] })))).rejects.toThrow(
        GoogleTokenInvalid,
      );
    });

    it('rejects an issuer that is not Google', async () => {
      const { subject } = service();
      const token = sign(claims({ iss: 'https://accounts.google.com.evil.test' }));

      await expect(subject.verify(token)).rejects.toThrow(GoogleTokenInvalid);
    });

    it('rejects an expired token, past the clock-skew allowance', async () => {
      const { subject } = service();
      const now = Math.floor(Date.now() / 1000);

      await expect(subject.verify(sign(claims({ exp: now - 120 })))).rejects.toThrow(
        GoogleTokenInvalid,
      );
    });

    it('accepts one that expired seconds ago, because our clock may be fast', async () => {
      const { subject } = service();
      const now = Math.floor(Date.now() / 1000);

      await expect(
        subject.verify(sign(claims({ exp: now - 5 }))),
      ).resolves.toMatchObject({ subject: '108000000000000000001' });
    });

    it('rejects one issued in the future', async () => {
      const { subject } = service();
      const now = Math.floor(Date.now() / 1000);

      await expect(subject.verify(sign(claims({ iat: now + 600 })))).rejects.toThrow(
        GoogleTokenInvalid,
      );
    });

    it('rejects a token with no email, having nothing to put in users.email', async () => {
      const { subject } = service();
      const { email: _dropped, ...rest } = claims();

      await expect(subject.verify(sign(rest))).rejects.toThrow(GoogleTokenInvalid);
    });
  });

  /**
   * `emailVerified` decides whether a Google identity may attach itself to an
   * existing password account, so everything that is not an explicit true has
   * to read as false. Boolean coercion here would make the string "false"
   * verified, which is the wrong direction to be wrong in.
   */
  describe('email_verified', () => {
    it.each([
      ['boolean true is verified', true, true],
      ['the string "true" is verified, Google having sent it historically', 'true', true],
      ['boolean false is not', false, false],
      ['the string "false" is not', 'false', false],
      ['an absent claim is not', undefined, false],
      ['a truthy number is not, which Boolean() would have got wrong', 1, false],
    ])('%s', async (_label, value, expected) => {
      const { subject } = service();
      const token = sign(claims({ email_verified: value }));

      await expect(subject.verify(token)).resolves.toMatchObject({
        emailVerified: expected,
      });
    });
  });

  describe('the key set', () => {
    it('is fetched once and reused across sign-ins', async () => {
      const { subject, fetches } = service();

      await subject.verify(sign(claims()));
      await subject.verify(sign(claims()));

      expect(fetches()).toBe(1);
    });

    it('rejects a key published for encryption rather than signing', async () => {
      const wrongUse = {
        ...(publicKey.export({ format: 'jwk' }) as object),
        kid: KID,
        alg: 'RS256',
        use: 'enc',
      };
      const { subject } = service([AUDIENCE], jwks(wrongUse));

      await expect(subject.verify(sign(claims()))).rejects.toThrow(GoogleTokenInvalid);
    });

    it('rejects a kid that is in no key set', async () => {
      const { subject } = service();

      await expect(
        subject.verify(sign(claims(), { kid: 'never-published' })),
      ).rejects.toThrow(GoogleTokenInvalid);
    });

    /**
     * A cold cache and no Google is an outage, not a rejected account — the
     * controller turns this into a 503 rather than signing the user out and
     * sending them to a password screen they may not have a password for.
     */
    it('reports Google being unreachable as its own failure', async () => {
      const { subject } = service([AUDIENCE], jwks(), { ok: false });

      await expect(subject.verify(sign(claims()))).rejects.toThrow(GoogleUnavailable);
    });
  });

  describe('malformed input', () => {
    it.each([
      ['not a JWT at all', 'hello'],
      ['two segments', 'aaa.bbb'],
      ['four segments', 'aaa.bbb.ccc.ddd'],
      ['a header that is not JSON', `${base64url('nonsense')}.x.y`],
      ['a header that is a JSON array', `${base64url('[1,2]')}.x.y`],
    ])('rejects %s', async (_label, token) => {
      const { subject } = service();
      await expect(subject.verify(token)).rejects.toThrow(GoogleTokenInvalid);
    });
  });

  describe('configuration', () => {
    it('is unconfigured with no client IDs, so the route can answer 503', () => {
      expect(service([]).subject.isConfigured).toBe(false);
      expect(service([AUDIENCE]).subject.isConfigured).toBe(true);
    });

    /**
     * An empty audience list rejects rather than waves through. The route
     * refuses to run at all in that state, and this is the second lock: if the
     * 503 check is ever removed, tokens still do not get in.
     */
    it('rejects every token when no audience is configured', async () => {
      const { subject } = service([]);

      await expect(subject.verify(sign(claims()))).rejects.toThrow(GoogleTokenInvalid);
    });
  });
});
