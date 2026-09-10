import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  PROBLEM_TYPES,
  type AdminAuthResponse,
  type AdminLoginRequest,
  type AdminSessionUser,
  type AdminTokenClaims,
} from '@nutricheck/contracts';
import { eq, schema, type Database } from '@nutricheck/database';
import { ttlToSeconds } from '../../../common/duration';
import { ProblemException } from '../../../common/problems';
import type { AppConfig } from '../../../config/config.schema';
import { DATABASE } from '../../../infrastructure/database/database.tokens';
import { PasswordService } from '../../auth/password.service';

function badCredentials(): ProblemException {
  return new ProblemException({
    type: PROBLEM_TYPES.unauthorized,
    title: 'Incorrect email or password',
    status: HttpStatus.UNAUTHORIZED,
  });
}

@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async login(input: AdminLoginRequest): Promise<AdminAuthResponse> {
    const [row] = await this.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.email, input.email))
      .limit(1);

    if (!row) {
      // Same timing-equalizing verify the app's own login does, so response
      // time cannot reveal whether an address has an admin account.
      await this.passwords.verifyDummy(input.password);
      throw badCredentials();
    }

    const ok = await this.passwords.verify(row.passwordHash, input.password);
    if (!ok) throw badCredentials();

    const [updated] = await this.db
      .update(schema.adminUsers)
      .set({ lastLoginAt: new Date() })
      .where(eq(schema.adminUsers.id, row.id))
      .returning();

    return this.issue(updated ?? row);
  }

  async me(adminId: string): Promise<AdminSessionUser> {
    const [row] = await this.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, adminId))
      .limit(1);

    // Reachable with a still-valid token after the admin row was removed.
    if (!row) throw badCredentials();
    return toSessionUser(row);
  }

  private async issue(row: typeof schema.adminUsers.$inferSelect): Promise<AdminAuthResponse> {
    const claims: AdminTokenClaims = { sub: row.id, email: row.email, name: row.name };
    const ttl = this.config.get('ADMIN_JWT_TTL', { infer: true });

    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.config.get('ADMIN_JWT_SECRET', { infer: true }),
      expiresIn: this.config.get('ADMIN_JWT_TTL', { infer: true }),
    });

    return {
      admin: toSessionUser(row),
      accessToken,
      tokenType: 'Bearer',
      expiresIn: ttlToSeconds(ttl),
    };
  }
}

function toSessionUser(row: typeof schema.adminUsers.$inferSelect): AdminSessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
  };
}
