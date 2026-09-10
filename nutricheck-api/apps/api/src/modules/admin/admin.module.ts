import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PasswordService } from '../auth/password.service';
import { AuthModule } from '../auth/auth.module';
import { CampaignModule } from '../campaign/campaign.module';
import { FeedbackModule } from '../feedback/feedback.module';
import { AdminAuthController } from './auth/admin-auth.controller';
import { AdminAuthService } from './auth/admin-auth.service';
import { AdminUsersController } from './users/admin-users.controller';
import { AdminUsersService } from './users/admin-users.service';
import { AdminFeedbackController } from './feedback/admin-feedback.controller';
import { AdminFoodsController } from './foods/admin-foods.controller';
import { AdminFoodsService } from './foods/admin-foods.service';
import { AdminDashboardController } from './dashboard/admin-dashboard.controller';
import { AdminDashboardService } from './dashboard/admin-dashboard.service';
import { AdminStarsController } from './stars/admin-stars.controller';
import { AdminStarsService } from './stars/admin-stars.service';
import { AdminCampaignController } from './campaign/admin-campaign.controller';
import { AdminGroupsController } from './groups/admin-groups.controller';
import { AdminGroupsService } from './groups/admin-groups.service';
import { AdminStepsController } from './steps/admin-steps.controller';
import { AdminStepsService } from './steps/admin-steps.service';

/**
 * The admin web app's whole backend surface, under /v1/admin/*.
 *
 * Imports AuthModule for AuthService.deleteAccount (soft-delete stays one
 * implementation, used by both the account holder and an admin) and
 * FeedbackModule for FeedbackService.list (the QA tab's data, reused rather
 * than re-queried). CampaignModule the same way — AdminCampaignController
 * reads and writes through the same `CampaignService` the app's own banner
 * route uses, rather than a second implementation of `computeFor`. Registers
 * its own PasswordService rather than having AuthModule export one — that
 * module's export surface is about sessions and tokens, and PasswordService
 * has no state to share, so a second instance costs nothing.
 */
@Module({
  imports: [JwtModule.register({}), AuthModule, FeedbackModule, CampaignModule],
  controllers: [
    AdminAuthController,
    AdminUsersController,
    AdminFeedbackController,
    AdminFoodsController,
    AdminDashboardController,
    AdminStarsController,
    AdminCampaignController,
    AdminGroupsController,
    AdminStepsController,
  ],
  providers: [
    PasswordService,
    AdminAuthService,
    AdminUsersService,
    AdminFoodsService,
    AdminDashboardService,
    AdminStarsService,
    AdminGroupsService,
    AdminStepsService,
  ],
})
export class AdminModule {}
