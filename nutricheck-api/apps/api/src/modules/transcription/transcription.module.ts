import { Module } from '@nestjs/common';
import { GeminiTranscriptionService } from './gemini.service';
import { TranscriptionController } from './transcription.controller';
import { TranscriptionService } from './transcription.service';

/**
 * Bound by the abstract class, not the concrete one, so the controller never
 * learns which provider it is talking to and a test can swap in a fake.
 */
@Module({
  controllers: [TranscriptionController],
  providers: [{ provide: TranscriptionService, useClass: GeminiTranscriptionService }],
  exports: [TranscriptionService],
})
export class TranscriptionModule {}
