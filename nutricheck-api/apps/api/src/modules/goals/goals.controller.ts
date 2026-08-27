import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Goal, GoalPreview, SuggestedTargets, UserProfile } from '@nutricheck/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PreviewGoalDto, SetGoalDto, UpdateProfileDto } from './goals.dto';
import { GoalsService } from './goals.service';
import { SuggestedTargetsService } from './suggested-targets.service';

@ApiTags('me')
@Controller({ path: 'me', version: '1' })
export class GoalsController {
  constructor(
    private readonly goals: GoalsService,
    private readonly suggested: SuggestedTargetsService,
  ) {}

  @Get('profile')
  @ApiOperation({ summary: 'The onboarding profile' })
  getProfile(@CurrentUser('sub') userId: string): Promise<UserProfile> {
    return this.goals.getProfile(userId);
  }

  /**
   * Saving the profile also recomputes the goal, because every input to the
   * goal math lives here. Recalculating on weight change is the reason goals
   * are append-only rather than updated in place.
   */
  @Put('profile')
  @ApiOperation({ summary: 'Save the profile and recompute targets' })
  updateProfile(
    @CurrentUser('sub') userId: string,
    @Body() body: UpdateProfileDto,
  ): Promise<UserProfile> {
    return this.goals.upsertProfile(userId, body);
  }

  @Get('goals')
  @ApiOperation({ summary: 'Current targets with the reasoning behind them' })
  current(@CurrentUser('sub') userId: string): Promise<Goal> {
    return this.goals.currentGoal(userId);
  }

  /**
   * Derives targets and persists nothing, so the targets screen can show the
   * consequence of a change before the user commits to it.
   *
   * Declared above `POST goals` only for readability — the paths are static
   * and do not shadow each other. It writes nothing, but it is not `@Public`:
   * the goal formula is not a thing to hand out to unauthenticated callers.
   */
  @Post('goals/preview')
  @ApiOperation({ summary: 'Derive targets from a profile without saving' })
  preview(@Body() body: PreviewGoalDto): GoalPreview {
    return this.goals.previewGoal(body);
  }

  /**
   * Targets a model proposed for this profile, next to nothing it was not given.
   *
   * Sits beside `goals/preview` because it takes the same unsaved profile: at
   * the point this is called the user is still in onboarding and has not
   * committed anything. It persists nothing either — the suggestion is a thing
   * to look at, and accepting it is a separate, explicit call.
   *
   * 503 when no model is configured, which the client treats as "no suggestion
   * available" rather than an error. Onboarding has always worked with the AI
   * switched off and still does; this is the one screen where it adds a card.
   */
  @Post('goals/suggest')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ask the model for targets, bounded by the server' })
  suggest(
    @CurrentUser('sub') userId: string,
    @Body() body: PreviewGoalDto,
  ): Promise<SuggestedTargets> {
    return this.suggested.suggest(userId, body);
  }

  @Get('goals/history')
  @ApiOperation({ summary: 'Every goal that has ever been in effect' })
  history(@CurrentUser('sub') userId: string): Promise<Goal[]> {
    return this.goals.history(userId);
  }

  /** Appends a new row; never updates one in place. */
  @Post('goals')
  @ApiOperation({ summary: 'Override one or more targets' })
  override(
    @CurrentUser('sub') userId: string,
    @Body() body: SetGoalDto,
  ): Promise<Goal> {
    return this.goals.override(userId, body);
  }
}
