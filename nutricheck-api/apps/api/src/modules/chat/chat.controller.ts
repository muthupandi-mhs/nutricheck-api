import { Body, Controller, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChatReply, ChatRequest, PROBLEM_TYPES } from '@nutricheck/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProblemThrottlerGuard } from '../../common/guards/problem-throttler.guard';
import { ProblemException } from '../../common/problems';
import { createZodDto } from '../../common/zod/zod-dto';
import { QuotaGuard } from '../quota/quota.guard';
import { ChatService } from './chat.service';

class ChatDto extends createZodDto(ChatRequest) {}

@ApiTags('chat')
@UseGuards(ProblemThrottlerGuard, QuotaGuard)
@Controller({ path: 'chat', version: '1' })
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /**
   * One turn with the assistant.
   *
   * A POST with no state behind it: the client carries the conversation and
   * sends the last few turns with each message. That is a deliberate limit
   * rather than an unfinished bit — a table of everything anybody has ever said
   * to this app is a retention decision nobody has taken, and the value of this
   * feature is in the conversation somebody is having right now, about the day
   * on the screen behind it.
   *
   * Costs a quota unit per turn, from the same daily allowance as meal parsing.
   * A question is a model call like any other, and the ceiling that makes this
   * app's spend predictable only works if everything counts against it.
   */
  @Post()
  @ApiOperation({ summary: 'Ask the assistant about today, or tell it what you ate' })
  async reply(@CurrentUser('sub') userId: string, @Body() body: ChatDto): Promise<ChatReply> {
    // The same degradation as every other AI route: no key is a supported
    // state, and a typed 503 lets the client say "not switched on" rather than
    // telling somebody their message was bad.
    if (!this.chat.isConfigured) {
      throw new ProblemException({
        type: PROBLEM_TYPES.resolverUnavailable,
        title: 'AI is unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: 'You can still log meals by voice or by typing them.',
      });
    }

    // QuotaGuard has already turned an exhausted allowance into a 429 with a
    // reset time, so there is nothing to catch here.
    return this.chat.reply(userId, body);
  }
}
