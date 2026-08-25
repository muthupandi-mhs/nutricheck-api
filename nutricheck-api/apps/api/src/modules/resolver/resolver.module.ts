import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { FoodsModule } from '../foods/foods.module';
import { QuotaModule } from '../quota/quota.module';
import { DraftStoreService } from './draft-store.service';
import { PortionPrefillService } from './portion-prefill.service';
import { ResolverController } from './resolver.controller';
import { ResolverService } from './resolver.service';

/**
 * The only module permitted three feature dependencies, which is precisely why
 * it exists as a module rather than as a service inside logs.
 */
@Module({
  imports: [AiModule, FoodsModule, QuotaModule],
  controllers: [ResolverController],
  providers: [ResolverService, PortionPrefillService, DraftStoreService],
  exports: [ResolverService],
})
export class ResolverModule {}
