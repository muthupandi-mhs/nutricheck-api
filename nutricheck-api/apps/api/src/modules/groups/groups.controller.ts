import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { GroupDetail, MyGroupsResponse } from '@nutricheck/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateGroupDto, GroupIdParamDto, JoinGroupDto } from './groups.dto';
import { GroupsService } from './groups.service';

/**
 * On `me`, beside weight/goals/steps — a group's membership is a fact about
 * the caller, and every route here answers "what am I part of," never
 * "list all groups."
 */
@ApiTags('me')
@Controller({ path: 'me/groups', version: '1' })
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  @ApiOperation({ summary: 'Every group the caller belongs to' })
  myGroups(@CurrentUser('sub') userId: string): Promise<MyGroupsResponse> {
    return this.groups.myGroups(userId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a group, seating the caller as its first member' })
  create(@CurrentUser('sub') userId: string, @Body() body: CreateGroupDto): Promise<GroupDetail> {
    return this.groups.create(userId, body);
  }

  @Post('join')
  @ApiOperation({ summary: 'Join a group by its invite code' })
  join(@CurrentUser('sub') userId: string, @Body() body: JoinGroupDto): Promise<GroupDetail> {
    return this.groups.join(userId, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One group in full: invite code and its leaderboard' })
  detail(@CurrentUser('sub') userId: string, @Param() params: GroupIdParamDto): Promise<GroupDetail> {
    return this.groups.detail(userId, params.id);
  }

  @Delete(':id/leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Leave a group' })
  leave(@CurrentUser('sub') userId: string, @Param() params: GroupIdParamDto): Promise<void> {
    return this.groups.leave(userId, params.id);
  }
}
