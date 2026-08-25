import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/config.schema';
import { AiRunsService } from './ai-runs.service';
import { AiService } from './ai.service';
import { AnthropicService } from './anthropic.service';
import { setFallbackRates } from './cost';
import { OpenAiCompatibleService } from './openai-compatible.service';

/**
 * The sealed AI boundary.
 *
 * The resolver is injected `AiService` — the abstract class — never a concrete
 * client, so the pipeline is testable without a network and the vendor is a
 * detail of this module. Adding a provider means adding one implementation
 * here; nothing downstream changes.
 *
 * Both implementations are instantiated: each is inert without its own key, and
 * constructing the unused one costs nothing but makes the choice a single
 * factory line rather than conditional module wiring.
 */
@Module({
  providers: [
    AnthropicService,
    OpenAiCompatibleService,
    {
      provide: AiService,
      inject: [ConfigService, AnthropicService, OpenAiCompatibleService],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        anthropic: AnthropicService,
        openai: OpenAiCompatibleService,
      ): AiService => {
        // Applied once, at wiring time, so a model with no built-in rate entry is
        // costable rather than refusing every call.
        setFallbackRates(
          config.get('AI_INPUT_USD_PER_MTOK', { infer: true }),
          config.get('AI_OUTPUT_USD_PER_MTOK', { infer: true }),
        );

        return config.get('AI_PROVIDER', { infer: true }) === 'openai-compatible'
          ? openai
          : anthropic;
      },
    },
    AiRunsService,
  ],
  exports: [AiService, AiRunsService],
})
export class AiModule {}
