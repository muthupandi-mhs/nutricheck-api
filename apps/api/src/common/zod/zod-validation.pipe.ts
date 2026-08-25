import {
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import { ZodError } from 'zod';
import { ValidationFailedException } from '../problems';
import { isZodDto } from './zod-dto';

/**
 * Global pipe. Any parameter typed with a createZodDto() class is parsed and
 * replaced by the parsed value — so a controller receives coerced, defaulted,
 * stripped data, never the raw body.
 *
 * Anything not backed by a Zod schema passes through untouched, which keeps
 * primitives (`@Param('id') id: string`) working without extra decoration.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const { metatype } = metadata;
    if (!isZodDto(metatype)) {
      return value;
    }

    try {
      return metatype.zodSchema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationFailedException(
          error.issues.map((issue) => ({
            path: issue.path.join('.') || '(root)',
            message: issue.message,
          })),
        );
      }
      throw error;
    }
  }
}
