import { AdminCreateFood, AdminFoodListQuery, AdminUpdateFood } from '@nutricheck/contracts';
import { createZodDto } from '../../../common/zod/zod-dto';

export class AdminFoodListQueryDto extends createZodDto(AdminFoodListQuery) {}
export class AdminCreateFoodDto extends createZodDto(AdminCreateFood) {}
export class AdminUpdateFoodDto extends createZodDto(AdminUpdateFood) {}
