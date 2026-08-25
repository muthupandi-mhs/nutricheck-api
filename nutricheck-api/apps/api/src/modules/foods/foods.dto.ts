import { FoodSearchQuery } from '@nutricheck/contracts';
import { createZodDto } from '../../common/zod/zod-dto';

export class FoodSearchQueryDto extends createZodDto(FoodSearchQuery) {}
