import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';

@Module({
  imports: [
    TerminusModule.forRoot({
      // Health checks must never be the thing that makes a pod look unhealthy.
      // A slow database should report `down` quickly, not hang the probe until
      // kubelet's own timeout fires and restarts the container.
      errorLogStyle: 'pretty',
      gracefulShutdownTimeoutMs: 5_000,
    }),
  ],
  controllers: [HealthController],
})
export class HealthModule {}
