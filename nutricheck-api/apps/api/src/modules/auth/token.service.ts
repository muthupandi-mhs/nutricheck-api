import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { AccessTokenClaims, TokenPair } from '@nutricheck/contracts';
import { and, eq, isNull, ne, schema, type Database } from '@nutricheck/database';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/config.schema';
import { DATABASE } from '../../infrastructure/database/database.tokens';

/** Presented refresh token was already rotated => it leaked. Family is revoked. */
export class RefreshReuseDetected extends Error {}
export class RefreshInvalid extends Error {}

type RotateOutcome =
  | { kind: 'ok'; tokens: TokenPair }
  | { kind: 'reuse'; familyId: string; userId: string }
  | { kind: 'invalid' };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function ttlToSeconds(ttl: string): number {
  const unit = ttl.slice(-1);
  const amount = Number(ttl.slice(0, -1));
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1;
  return amount * multiplier;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  get accessTtlSeconds(): number {
    return ttlToSeconds(this.config.get('JWT_ACCESS_TTL', { infer: true }));
  }

  /**
   * Issue a fresh pair. `familyId` starts a new rotation chain — one per login,
   * so revoking a compromised session does not log the user out everywhere.
   */
  async issue(
    userId: string,
    email: string,
    familyId = randomUUID(),
  ): Promise<TokenPair> {
    const claims: AccessTokenClaims = { sub: userId, email, sid: familyId };

    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }),
    });

    // Opaque, not a JWT. There is nothing to read in a refresh token, and an
    // opaque value can be revoked server-side — a stateless JWT cannot.
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshTtl = ttlToSeconds(this.config.get('JWT_REFRESH_TTL', { infer: true }));

    await this.db.insert(schema.refreshTokens).values({
      userId,
      familyId,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + refreshTtl * 1000),
    });

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTtlSeconds,
    };
  }

  async verifyAccess(token: string): Promise<AccessTokenClaims> {
    return this.jwt.verifyAsync<AccessTokenClaims>(token, {
      secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
    });
  }

  /**
   * Rotate. The presented token is marked replaced in the same transaction that
   * issues its successor, so a race cannot mint two live successors.
   *
   * Reuse detection: presenting a token that already has `replacedBy` set means
   * someone is holding a copy that was rotated away. The whole family is
   * revoked, not just that token, because we cannot tell whether the legitimate
   * client or the attacker is the one in front of us.
   *
   * The transaction returns an OUTCOME rather than throwing from inside it.
   * Throwing inside the callback rolls the transaction back — which would undo
   * the very revocation the reuse branch just performed, leaving the leaked
   * family fully usable. The revoke therefore runs after the read transaction
   * has ended, in its own statement.
   */
  async rotate(presented: string): Promise<TokenPair> {
    const presentedHash = sha256(presented);

    const outcome = await this.db.transaction(async (tx): Promise<RotateOutcome> => {
      const [row] = await tx
        .select()
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.tokenHash, presentedHash))
        .limit(1);

      if (!row) return { kind: 'invalid' };

      if (row.replacedBy !== null) {
        return { kind: 'reuse', familyId: row.familyId, userId: row.userId };
      }

      if (row.revokedAt !== null || row.expiresAt.getTime() <= Date.now()) {
        return { kind: 'invalid' };
      }

      const [user] = await tx
        .select({ email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, row.userId))
        .limit(1);

      if (!user) return { kind: 'invalid' };

      const next = randomBytes(32).toString('base64url');
      const refreshTtl = ttlToSeconds(
        this.config.get('JWT_REFRESH_TTL', { infer: true }),
      );

      const [inserted] = await tx
        .insert(schema.refreshTokens)
        .values({
          userId: row.userId,
          familyId: row.familyId,
          tokenHash: sha256(next),
          expiresAt: new Date(Date.now() + refreshTtl * 1000),
        })
        .returning({ id: schema.refreshTokens.id });

      await tx
        .update(schema.refreshTokens)
        .set({ replacedBy: inserted!.id })
        .where(eq(schema.refreshTokens.id, row.id));

      const accessToken = await this.jwt.signAsync(
        {
          sub: row.userId,
          email: user.email,
          sid: row.familyId,
        } satisfies AccessTokenClaims,
        {
          secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
          expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }),
        },
      );

      return {
        kind: 'ok',
        tokens: {
          accessToken,
          refreshToken: next,
          tokenType: 'Bearer',
          expiresIn: this.accessTtlSeconds,
        },
      };
    });

    if (outcome.kind === 'reuse') {
      await this.revokeFamily(outcome.familyId);
      this.logger.warn(
        { userId: outcome.userId, familyId: outcome.familyId },
        'refresh token reuse detected — family revoked',
      );
      throw new RefreshReuseDetected();
    }

    if (outcome.kind === 'invalid') throw new RefreshInvalid();

    return outcome.tokens;
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.db
      .update(schema.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.refreshTokens.familyId, familyId),
          isNull(schema.refreshTokens.revokedAt),
        ),
      );
  }

  /** Logout: revoke the presented token's whole family, not just that token. */
  async revokeFamilyOf(presented: string): Promise<void> {
    const [row] = await this.db
      .select({ familyId: schema.refreshTokens.familyId })
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.tokenHash, sha256(presented)))
      .limit(1);

    if (!row) return; // Already gone. Logout is idempotent by design.
    await this.revokeFamily(row.familyId);
  }

  /**
   * Revokes every session on the account.
   *
   * `exceptFamilyId` spares one family — the caller's own — so a password
   * change can sign out every OTHER device without also signing out the
   * device the change was made from. Omit it (account deletion, the
   * account-takeover path) to revoke everything with no exception.
   */
  async revokeAllForUser(userId: string, exceptFamilyId?: string): Promise<void> {
    await this.db
      .update(schema.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.refreshTokens.userId, userId),
          isNull(schema.refreshTokens.revokedAt),
          exceptFamilyId ? ne(schema.refreshTokens.familyId, exceptFamilyId) : undefined,
        ),
      );
  }
}
