import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';
import type { AppConfig } from '../../config/config.schema';

/**
 * Google's signing keys. Public, unauthenticated, and rotated every few days —
 * which is why this is fetched at runtime rather than pinned in config.
 */
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Both spellings are issued in the wild, and Google's own docs accept both. */
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/**
 * Allowance for the clock on this box disagreeing with Google's.
 *
 * Applied to `exp` and to `iat`. Sixty seconds is small enough that an expired
 * token is not usefully extended, and large enough that a server whose NTP has
 * drifted a little does not reject every genuine sign-in — a failure that looks
 * exactly like "Google is broken" from the phone.
 */
const CLOCK_SKEW_SECONDS = 60;

/** A dead JWKS endpoint must fail the sign-in, not hang the request. */
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Floor between forced JWKS refetches.
 *
 * An unknown `kid` triggers a refetch, and an unknown `kid` is something an
 * attacker can produce at will by signing garbage with a key we have never
 * seen. Without this floor that is a free amplifier: one cheap request here
 * becomes one request to Google, as fast as they care to send them.
 */
const MIN_REFETCH_INTERVAL_MS = 60_000;

/** Fallback when Google's response carries no usable Cache-Control. */
const DEFAULT_CACHE_MS = 3_600_000;

/** Every rejection reaches the controller as this, with no detail for the client. */
export class GoogleTokenInvalid extends Error {}

/** Google is configured but unreachable — a 503, not a rejected sign-in. */
export class GoogleUnavailable extends Error {}

/**
 * What a verified token actually establishes about the person holding it.
 *
 * `subject` is the only stable identifier here and the only thing keyed on.
 * The email can change — people rename Gmail accounts, and Workspace admins
 * change them for you — so an account matched on email would follow the address
 * rather than the person.
 */
export interface GoogleIdentity {
  /** `sub`. Stable for the life of the Google account, unique per issuer. */
  subject: string;
  email: string;
  /**
   * Whether GOOGLE says it verified the address, not whether it looks valid.
   * This gates linking to an existing password account, so it is read
   * strictly — see `readClaims`.
   */
  emailVerified: boolean;
}

type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
type Jwks = { keys: Jwk[] };

/**
 * Verifies Google ID tokens locally, against Google's published keys.
 *
 * Local verification rather than a call to Google's `tokeninfo` endpoint, the
 * other documented option: tokeninfo puts a network round trip and a
 * third-party rate limit on the critical path of every sign-in, and Google's
 * own guidance is to validate locally in production.
 *
 * No SDK. `google-auth-library` would do this, and adding it would put the only
 * Google SDK in the tree here for one route — `GeminiTranscriptionService`
 * already talks to Google over plain fetch for the same reason. What that saves
 * in dependency weight it costs in care, so the checks are written out one at a
 * time rather than assumed:
 *
 *   1. `alg` is RS256 — read from the header but never TRUSTED from it. The
 *      header is attacker-authored, and accepting whatever it names is the
 *      classic JWT break in both its forms: `none` (no signature at all) and
 *      `HS256` (verify using the public key as an HMAC secret, which the
 *      attacker also has, because it is public).
 *   2. The signature verifies against the key named by `kid`.
 *   3. `iss` is Google.
 *   4. `aud` is one of OUR client IDs. See the config comment: without this,
 *      a valid Google token from any app on earth signs somebody in here.
 *   5. `exp` has not passed and `iat` is not in the future.
 *
 * Every failure is the same exception with no detail. Which check failed is
 * useful to someone probing the endpoint and useless to the phone, which can
 * only ever say "that did not work".
 */
@Injectable()
export class GoogleIdentityService {
  private readonly log = new Logger(GoogleIdentityService.name);
  private readonly audiences: readonly string[];

  private cached: Jwks | null = null;
  private cacheExpiresAt = 0;
  private lastFetchAt = 0;
  /**
   * The single in-flight fetch. Sign-ins arrive concurrently, and a cold cache
   * would otherwise send Google one request per waiting caller.
   */
  private fetching: Promise<Jwks> | null = null;

  constructor(config: ConfigService<AppConfig, true>) {
    this.audiences = config.get('GOOGLE_OAUTH_CLIENT_IDS', { infer: true });
  }

  /**
   * False disables the route, the same way a missing key disables
   * transcription. An empty audience list would reject every token anyway; a
   * 503 says "not offered here" rather than "your account was refused", and
   * only one of those is true.
   */
  get isConfigured(): boolean {
    return this.audiences.length > 0;
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new GoogleTokenInvalid('not a JWS');

    const [encodedHeader, encodedPayload, encodedSignature] = parts as [
      string,
      string,
      string,
    ];

    const header = decodeSegment(encodedHeader);

    if (header.alg !== 'RS256') throw new GoogleTokenInvalid('unexpected alg');
    if (typeof header.kid !== 'string' || header.kid === '') {
      throw new GoogleTokenInvalid('no kid');
    }

    const signature = Buffer.from(encodedSignature, 'base64url');
    const signed = `${encodedHeader}.${encodedPayload}`;

    if (!(await this.verifySignature(header.kid, signed, signature))) {
      throw new GoogleTokenInvalid('bad signature');
    }

    // Claims are read only AFTER the signature verifies, so nothing below is
    // parsing attacker-authored data.
    return this.readClaims(decodeSegment(encodedPayload));
  }

  /**
   * True only if `kid` names a key we hold and that key verifies the signature.
   *
   * An unknown `kid` is refetched once — the ordinary path on the day Google
   * rotates — and the refetch is floored, because an unknown `kid` is also free
   * for an attacker to produce.
   */
  private async verifySignature(
    kid: string,
    signed: string,
    signature: Buffer,
  ): Promise<boolean> {
    let jwks = await this.keys();
    let jwk = jwks.keys.find((k) => k.kid === kid);

    if (!jwk && Date.now() - this.lastFetchAt > MIN_REFETCH_INTERVAL_MS) {
      this.cacheExpiresAt = 0;
      jwks = await this.keys();
      jwk = jwks.keys.find((k) => k.kid === kid);
    }

    if (!jwk) return false;
    // A key published for something other than signing must not verify one.
    if (jwk.use !== undefined && jwk.use !== 'sig') return false;
    if (jwk.alg !== undefined && jwk.alg !== 'RS256') return false;

    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      return createVerify('RSA-SHA256').update(signed).verify(key, signature);
    } catch {
      // A malformed JWK, or bytes that are not an RSA signature at all. Both
      // mean "did not verify" — never a 500, which would tell whoever sent it
      // that their probe reached something.
      return false;
    }
  }

  /** The five claim checks. Order is irrelevant; all of them must pass. */
  private readClaims(payload: Record<string, unknown>): GoogleIdentity {
    const { iss, aud, sub, exp, iat, email, email_verified: emailVerified } = payload;

    if (typeof iss !== 'string' || !ISSUERS.has(iss)) {
      throw new GoogleTokenInvalid('wrong issuer');
    }

    // `aud` is a string on an ID token. The JWT spec permits an array and
    // Google does not send one, so an array here is not a token minted for us.
    if (typeof aud !== 'string' || !this.audiences.includes(aud)) {
      throw new GoogleTokenInvalid('wrong audience');
    }

    if (typeof sub !== 'string' || sub === '') throw new GoogleTokenInvalid('no sub');

    const now = Math.floor(Date.now() / 1000);
    if (typeof exp !== 'number' || exp + CLOCK_SKEW_SECONDS < now) {
      throw new GoogleTokenInvalid('expired');
    }
    if (typeof iat !== 'number' || iat - CLOCK_SKEW_SECONDS > now) {
      throw new GoogleTokenInvalid('issued in the future');
    }

    if (typeof email !== 'string' || email === '') {
      // Google sends `email` whenever the app asked for the scope, and this one
      // does. Without it there is nothing to put in users.email.
      throw new GoogleTokenInvalid('no email');
    }

    return {
      subject: sub,
      // The same normalisation the Email contract applies, so a Google address
      // and a typed one compare equal instead of becoming two accounts.
      email: email.trim().toLowerCase(),
      // Strict, and deliberately not `Boolean(...)`. Anything that is not a
      // true — the boolean, or the string Google has historically sent — reads
      // as unverified, which is the safe direction: this flag is the whole of
      // what decides whether an existing account may be linked.
      emailVerified: emailVerified === true || emailVerified === 'true',
    };
  }

  private async keys(): Promise<Jwks> {
    if (this.cached && Date.now() < this.cacheExpiresAt) return this.cached;
    this.fetching ??= this.fetchKeys().finally(() => {
      this.fetching = null;
    });
    return this.fetching;
  }

  private async fetchKeys(): Promise<Jwks> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(JWKS_URL, { signal: controller.signal });
      if (!response.ok) throw new GoogleUnavailable(`JWKS ${response.status}`);

      const body = (await response.json()) as Jwks;
      if (!Array.isArray(body?.keys)) throw new GoogleUnavailable('malformed JWKS');

      this.cached = body;
      this.lastFetchAt = Date.now();
      this.cacheExpiresAt = Date.now() + cacheMs(response.headers.get('cache-control'));
      return body;
    } catch (error) {
      /**
       * A stale key set beats no key set.
       *
       * Google's keys stay valid well past the cache lifetime they advertise,
       * so serving known-but-expired keys through an outage keeps sign-in
       * working. Only a cold cache turns a Google outage into an outage here.
       */
      if (this.cached) {
        this.log.warn({ err: error }, 'JWKS refresh failed — serving the cached key set');
        // Do not retry on every request for as long as Google is down.
        this.cacheExpiresAt = Date.now() + MIN_REFETCH_INTERVAL_MS;
        return this.cached;
      }
      throw error instanceof GoogleUnavailable
        ? error
        : new GoogleUnavailable('could not reach Google');
    } finally {
      clearTimeout(timer);
    }
  }
}

function decodeSegment(segment: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(segment, 'base64url').toString('utf8'),
    );
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new GoogleTokenInvalid('malformed segment');
  }
}

/**
 * Google advertises how long its keys are good for, and it is worth honouring —
 * refetching on a timer we invented is either wasted requests or stale keys on
 * the day of a rotation.
 */
function cacheMs(cacheControl: string | null): number {
  const maxAge = cacheControl?.match(/max-age=(\d+)/)?.[1];
  if (!maxAge) return DEFAULT_CACHE_MS;
  // Ten minutes of headroom so we rotate slightly before Google does, and never
  // a negative window from a max-age that has already nearly elapsed.
  return Math.max(60_000, Number(maxAge) * 1000 - 600_000);
}
