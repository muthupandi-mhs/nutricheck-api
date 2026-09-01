import { Module, VersioningType } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from '../../../common/zod/zod-validation.pipe';
import { FastingController } from '../fasting.controller';
import { FastingService } from '../fasting.service';

/**
 * The routes, as the app actually serves them.
 *
 * `fasting.int-spec.ts` proves the service; this proves the wiring, which no
 * other test touches and which fails in the one way that is invisible until
 * runtime. docs/BACKEND.md says it plainly: eleven of the client's route
 * comments were once wrong, and every one of them would only have surfaced as
 * a 404 on a device.
 *
 * So the assertions here are about paths, methods, status codes and what the
 * controller hands the service — never about what the service then does. The
 * service is a stub, and deliberately: a database would make this a slower
 * copy of the integration suite and would stop it proving the one thing it is
 * for.
 *
 * Fastify and URI versioning, both because that is what `main.ts` builds. An
 * express app with no versioning would answer `/me/fasting` happily and tell
 * us nothing about whether `/v1/me/fasting` exists.
 */
const USER = '00000000-0000-4000-8000-0000000000aa';
const FAST = '11111111-1111-4111-8111-111111111111';

/** Whatever the summary is, the controller only passes it through. */
const SUMMARY = { current: null, recent: [], stats: null, lastTargetHours: 16 };

describe('fasting routes', () => {
  let app: NestFastifyApplication;
  const service = {
    summary: jest.fn().mockResolvedValue(SUMMARY),
    start: jest.fn().mockResolvedValue(SUMMARY),
    adjust: jest.fn().mockResolvedValue(SUMMARY),
    end: jest.fn().mockResolvedValue(SUMMARY),
    remove: jest.fn().mockResolvedValue(SUMMARY),
  };

  @Module({
    controllers: [FastingController],
    providers: [
      { provide: FastingService, useValue: service },
      // The real pipe, so the DTOs are genuinely exercised: a query default
      // that never fires and a uuid that is never checked would both pass a
      // test that stubbed this out.
      { provide: APP_PIPE, useClass: ZodValidationPipe },
    ],
  })
  class Probe {}

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [Probe] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

    // What JwtAuthGuard does in the real app. `@CurrentUser('sub')` indexes
    // the claims directly, so a request with none throws before the handler.
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('preHandler', (req, _res, done) => {
        (req as unknown as { user: unknown }).user = { sub: USER };
        done();
      });

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    for (const fn of Object.values(service)) fn.mockClear();
  });

  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url, payload: payload as object });

  describe('reading', () => {
    it('serves GET /v1/me/fasting, with the history bounded by default', async () => {
      const res = await call('GET', '/v1/me/fasting');

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(SUMMARY);
      // 30 is the contract's default and it has to arrive as a NUMBER — the
      // query string is text, and a service handed "30" would put a string in
      // a LIMIT clause.
      expect(service.summary).toHaveBeenCalledWith(USER, 30);
    });

    it('takes a limit off the query string', async () => {
      await call('GET', '/v1/me/fasting?limit=5');
      expect(service.summary).toHaveBeenCalledWith(USER, 5);
    });

    it('refuses a limit outside the contract', async () => {
      const res = await call('GET', '/v1/me/fasting?limit=9999');

      expect(res.statusCode).toBe(422);
      expect(service.summary).not.toHaveBeenCalled();
    });
  });

  describe('starting', () => {
    it('serves POST /v1/me/fasting and answers 200, not 201', async () => {
      // 200 because what comes back is the whole summary, not the fast that
      // was created — a 201 would be a claim about a resource this response
      // does not contain.
      const res = await call('POST', '/v1/me/fasting', { targetHours: 16 });

      expect(res.statusCode).toBe(200);
      expect(service.start).toHaveBeenCalledWith(USER, { targetHours: 16 }, 30);
    });

    it('passes a backdated start through untouched', async () => {
      const startedAt = '2026-08-31T20:00:00.000Z';
      await call('POST', '/v1/me/fasting', { targetHours: 18, startedAt });

      expect(service.start).toHaveBeenCalledWith(USER, { targetHours: 18, startedAt }, 30);
    });

    it('refuses a target outside the bounds before the service sees it', async () => {
      const res = await call('POST', '/v1/me/fasting', { targetHours: 200 });

      expect(res.statusCode).toBe(422);
      expect(service.start).not.toHaveBeenCalled();
    });

    it('refuses a start that is not an instant', async () => {
      const res = await call('POST', '/v1/me/fasting', {
        targetHours: 16,
        startedAt: '2026-08-31',
      });

      expect(res.statusCode).toBe(422);
      expect(service.start).not.toHaveBeenCalled();
    });
  });

  describe('the running fast', () => {
    it('serves PATCH /v1/me/fasting/current', async () => {
      const res = await call('PATCH', '/v1/me/fasting/current', { targetHours: 18 });

      expect(res.statusCode).toBe(200);
      expect(service.adjust).toHaveBeenCalledWith(USER, { targetHours: 18 }, 30);
    });

    it('lets an empty body reach the service, which is what rejects it', async () => {
      // Both fields are optional in the contract on purpose — "at least one"
      // is a rule with a field name on it, and the service states it. A schema
      // that refused this here would produce a message pointing nowhere.
      const res = await call('PATCH', '/v1/me/fasting/current', {});

      expect(res.statusCode).toBe(200);
      expect(service.adjust).toHaveBeenCalledWith(USER, {}, 30);
    });

    it('serves POST /v1/me/fasting/current/end without a body', async () => {
      const res = await call('POST', '/v1/me/fasting/current/end', {});

      expect(res.statusCode).toBe(200);
      expect(service.end).toHaveBeenCalledWith(USER, {}, 30);
    });

    it('does not mistake the end route for a fast called "current"', async () => {
      // `POST fasting/current/end` and `DELETE fasting/:id` share a prefix.
      // Nest orders them by declaration, so a rename that made `:id` greedier
      // would silently route "end" into the delete handler.
      await call('POST', '/v1/me/fasting/current/end', {});

      expect(service.end).toHaveBeenCalled();
      expect(service.remove).not.toHaveBeenCalled();
    });
  });

  describe('discarding', () => {
    it('serves DELETE /v1/me/fasting/:id', async () => {
      const res = await call('DELETE', `/v1/me/fasting/${FAST}`);

      expect(res.statusCode).toBe(200);
      expect(service.remove).toHaveBeenCalledWith(USER, FAST, 30);
    });

    it('refuses an id that is not a uuid', async () => {
      // A 422 naming the field, rather than a query that hands Postgres
      // "banana" and fails as a 500 about invalid input syntax.
      const res = await call('DELETE', '/v1/me/fasting/banana');

      expect(res.statusCode).toBe(422);
      expect(service.remove).not.toHaveBeenCalled();
    });
  });

  describe('the paths the client actually calls', () => {
    it('serves nothing off the unversioned prefix', async () => {
      // `enableVersioning` is applied in main.ts, not by the controller
      // decorator alone. If it were ever dropped, every route here would move
      // and every call from the app would 404.
      expect((await call('GET', '/me/fasting')).statusCode).toBe(404);
    });

    it('has no route where the weight screen lives', async () => {
      // Both controllers are mounted on `me`. This is the cheap proof that
      // adding fasting did not capture a path belonging to its neighbour.
      expect((await call('GET', '/v1/me/weight')).statusCode).toBe(404);
    });
  });
});
