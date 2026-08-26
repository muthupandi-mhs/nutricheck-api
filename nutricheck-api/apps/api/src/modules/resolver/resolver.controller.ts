import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ResolveRequest, type ResolveDraft } from '@nutricheck/contracts';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProblemThrottlerGuard } from '../../common/guards/problem-throttler.guard';
import { TimeoutInterceptor } from '../../common/interceptors/timeout.interceptor';
import { NotFoundProblem } from '../../common/problems';
import { createZodDto } from '../../common/zod/zod-dto';
import { QuotaGuard } from '../quota/quota.guard';
import { ResolverService } from './resolver.service';

class ResolveDto extends createZodDto(ResolveRequest) {}

/**
 * The only AI route in v1, and the one the product is judged on.
 *
 * Its own timeout and its own quota guard, because it is the only route that
 * can fail because of a third party. Everything it can fail into — search, the
 * repeat strip, committing a log — keeps working.
 */
@ApiTags('resolve')
@Controller({ path: 'resolve', version: '1' })
@UseGuards(ProblemThrottlerGuard, QuotaGuard)
@UseInterceptors(new TimeoutInterceptor(8_000))
export class ResolverController {
  constructor(private readonly resolver: ResolverService) {}

  /**
   * Streams by default; returns a single JSON draft when the client asks for
   * it. Both paths run the same generator, so they cannot drift — the eval
   * harness and the integration tests use the JSON form.
   */
  @Post()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiOperation({ summary: 'Turn a phrase into a draft. Writes nothing to the log.' })
  async resolve(
    @CurrentUser('sub') userId: string,
    @Body() body: ResolveDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: false }) reply: FastifyReply,
  ): Promise<void> {
    const wantsJson = (request.headers.accept ?? '').includes('application/json');

    if (wantsJson) {
      const draft = await this.resolver.resolveOnce(userId, body);
      void reply.status(200).send(draft);
      return;
    }

    // Written to the raw socket rather than through @Sse(): SSE through a proxy
    // chain fails in more ways than any other route shape, and owning the
    // headers is how the buffering ones get disabled.
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // nginx and several ingress controllers buffer the whole response
      // otherwise, which turns a progressive sheet back into a spinner.
      'x-accel-buffering': 'no',
    });

    try {
      for await (const event of this.resolver.resolve(userId, body)) {
        reply.raw.write(`event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      // The stream has already started, so a status code is no longer
      // available. The client maps this frame to a failure-path row.
      const problem =
        error instanceof Error ? { title: error.message } : { title: 'resolve failed' };
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ event: 'error', problem })}\n\n`);
    } finally {
      reply.raw.end();
    }
  }

  /** Drafts live an hour; the sheet re-fetches if the app was backgrounded. */
  @Get(':draftId')
  @ApiOperation({ summary: 'Re-read a draft' })
  async getDraft(
    @Param('draftId', ParseUUIDPipe) draftId: string,
  ): Promise<ResolveDraft> {
    const draft = await this.resolver.getDraft(draftId);
    if (!draft) throw new NotFoundProblem('Draft');
    return draft;
  }
}
