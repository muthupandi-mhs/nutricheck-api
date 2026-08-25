import { Module } from '@nestjs/common';
import { AiRunsService } from './ai-runs.service';
import { AiService } from './ai.service';
import { AnthropicService } from './anthropic.service';

/**
 * The sealed AI boundary.
 *
 * The resolver is injected `AiService` — the abstract interface — never the
 * concrete client, so the pipeline is unit-testable without a network and the
 * vendor is a detail of this module.
 */
@Module({
  providers: [
    AnthropicService,
    { provide: AiService, useExisting: AnthropicService },
    AiRunsService,
  ],
  exports: [AiService, AiRunsService],
})
export class AiModule {}
