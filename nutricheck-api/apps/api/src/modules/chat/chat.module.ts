import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { LogsModule } from '../logs/logs.module';
import { QuotaModule } from '../quota/quota.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

/**
 * The assistant behind the microphone sheet.
 *
 * Takes LogsModule rather than the database for the reason Insights and Ideas
 * do: what the assistant is allowed to say about somebody's day has to be the
 * same day the screen behind it is showing, and there is one method that
 * computes that. Two readings of one day is how an app ends up arguing with
 * itself in front of a user.
 *
 * QuotaModule because a turn is a billed model call, on the same allowance as
 * everything else. There is no cache: two identical questions an hour apart
 * have different answers, because the day between them has moved.
 */
@Module({
  imports: [AiModule, LogsModule, QuotaModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
