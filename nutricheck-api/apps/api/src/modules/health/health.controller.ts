import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  type HealthCheckResult,
} from '@nestjs/terminus';
import { DatabaseHealthIndicator } from '../../infrastructure/database/database.health';
import { RedisHealthIndicator } from '../../infrastructure/redis/redis.health';

/**
 * Three probes, three different questions. Conflating them is the most common
 * way a healthy service gets restarted during a dependency blip.
 *
 *   /health/live    — is this process wedged?           failure => restart me
 *   /health/ready   — can it serve traffic right now?   failure => stop routing to me
 *   /health/startup — has it finished booting?          failure => keep waiting
 */
/**
 * Public, and it must stay that way. JwtAuthGuard is global and fail-closed, so
 * without this the probes get a 401 and the pod never becomes ready — the
 * orchestrator has no credentials to present and never will.
 */
@Public()
@ApiExcludeController()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly database: DatabaseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /**
   * Deliberately checks nothing external. If the event loop can answer this,
   * the process is alive; anything more turns a database outage into a
   * cluster-wide restart storm.
   */
  @Get('live')
  @HealthCheck()
  live(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 900 * 1024 * 1024),
    ]);
  }

  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.database.check('database'),
      () => this.redis.check('redis'),
    ]);
  }

  @Get('startup')
  @HealthCheck()
  startup(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.database.check('database'),
      () => this.redis.check('redis'),
    ]);
  }
}
