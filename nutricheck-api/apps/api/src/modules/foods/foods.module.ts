import { Module } from '@nestjs/common';
import { FoodsController } from './foods.controller';
import { FoodsService } from './foods.service';

@Module({
  controllers: [FoodsController],
  providers: [FoodsService],
  // Exported: the resolver's candidate-search stage uses the same service, so
  // search quality and resolver quality cannot drift apart.
  exports: [FoodsService],
})
export class FoodsModule {}
