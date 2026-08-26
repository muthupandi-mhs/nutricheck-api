import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PROBLEM_TYPES,
  TranscribeRequest,
  type TranscribeResult,
} from '@nutricheck/contracts';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProblemThrottlerGuard } from '../../common/guards/problem-throttler.guard';
import { ProblemException } from '../../common/problems';
import { createZodDto } from '../../common/zod/zod-dto';
import type { AppConfig } from '../../config/config.schema';
import {
  TranscriptionEmptyError,
  TranscriptionService,
  TranscriptionUnavailableError,
} from './transcription.service';

class TranscribeDto extends createZodDto(TranscribeRequest) {}

/**
 * The one route in the API that accepts audio.
 *
 * `/v1/resolve` still returns 415 for it, and that separation is deliberate:
 * transcription produces TEXT, which the user reads and edits before anything
 * is resolved or logged. Folding the two together would remove the step where
 * a bad transcript is fixed by typing rather than by re-recording.
 */
@ApiTags('transcription')
@Controller({ path: 'transcribe', version: '1' })
@UseGuards(ProblemThrottlerGuard)
export class TranscriptionController {
  constructor(
    private readonly transcription: TranscriptionService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Throttled harder than the resolver. Every call ships audio and is billed by
   * duration, so this is the easiest route in the API to run up a bill on, and
   * the device only reaches for it when its own recogniser has already failed.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Transcribe dictated audio when on-device recognition is weak' })
  async transcribe(
    @CurrentUser('sub') _userId: string,
    @Body() body: TranscribeDto,
  ): Promise<TranscribeResult> {
    if (!this.transcription.isConfigured) {
      // Same degradation as the resolver without a key: the feature is absent,
      // not broken, and the device simply stays on its own recogniser.
      throw new ProblemException({
        type: PROBLEM_TYPES.resolverUnavailable,
        title: 'Dictation help is unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: 'Keep using your phone’s own dictation, or type it instead.',
      });
    }

    const audio = Buffer.from(body.audio, 'base64');
    const max = this.config.get('TRANSCRIBE_MAX_BYTES', { infer: true });

    // Checked on the DECODED length: a base64 string is ~33% larger, so a limit
    // applied to the string would let through a third more audio than intended.
    if (audio.byteLength === 0 || audio.byteLength > max) {
      throw new ProblemException({
        type: PROBLEM_TYPES.validationFailed,
        title: 'That recording is too long',
        status: HttpStatus.PAYLOAD_TOO_LARGE,
        detail: 'Say it in a shorter sentence, or type it instead.',
      });
    }

    try {
      return await this.transcription.transcribe({
        audio,
        mimeType: body.mimeType,
        locale: body.locale,
      });
    } catch (error) {
      if (error instanceof TranscriptionEmptyError) {
        // Not a failure the user caused, and not one worth an error screen —
        // silence is the ordinary answer when the mic caught nothing.
        return {
          text: '',
          locale: body.locale,
          model: '',
          latencyMs: 0,
        };
      }
      if (error instanceof TranscriptionUnavailableError) {
        throw new ProblemException({
          type: PROBLEM_TYPES.resolverUnavailable,
          title: 'Could not hear that',
          status: HttpStatus.SERVICE_UNAVAILABLE,
          detail: 'Your phone’s own dictation still works, or you can type it.',
        });
      }
      throw error;
    }
  }
}
