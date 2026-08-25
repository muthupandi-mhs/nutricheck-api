import { Injectable } from '@nestjs/common';
import { hash, verify, Algorithm } from '@node-rs/argon2';

/**
 * Argon2id, the OWASP first choice for password storage.
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet's m=19456 (19 MiB),
 * t=2, p=1 configuration. They are stored inside the encoded hash string, so
 * raising them later does not invalidate existing hashes — `verify` reads each
 * hash's own parameters, and `needsRehash` tells us which ones to upgrade on
 * the next successful login.
 */
const PARAMS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * A hash of a throwaway value, computed once at startup.
 *
 * Login verifies against this when the email is unknown, so a request for a
 * non-existent account costs the same ~50ms as a real one. Without it, response
 * time alone tells an attacker which addresses are registered.
 */
const DUMMY_HASH = hash('nutricheck-timing-equalizer', PARAMS);

@Injectable()
export class PasswordService {
  async hash(plain: string): Promise<string> {
    return hash(plain, PARAMS);
  }

  async verify(encoded: string, plain: string): Promise<boolean> {
    try {
      return await verify(encoded, plain, PARAMS);
    } catch {
      // A malformed stored hash must read as "wrong password", never as a 500 —
      // a crash here would leak that the account exists.
      return false;
    }
  }

  /** Burn equivalent CPU when there is no account to check. */
  async verifyDummy(plain: string): Promise<void> {
    try {
      await verify(await DUMMY_HASH, plain, PARAMS);
    } catch {
      /* expected: the value never matches */
    }
  }
}
