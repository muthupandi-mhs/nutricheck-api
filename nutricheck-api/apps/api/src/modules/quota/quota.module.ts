import { Module } from '@nestjs/common';
import { QuotaController } from './quota.controller';
import { QuotaGuard } from './quota.guard';
import { QuotaService } from './quota.service';

@Module({
  controllers: [QuotaController],
  providers: [QuotaService, QuotaGuard],
  exports: [QuotaService, QuotaGuard],
})
export class QuotaModule {}
