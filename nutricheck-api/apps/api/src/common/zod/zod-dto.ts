import { ApiProperty } from '@nestjs/swagger';
import type { ZodTypeAny, z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * A Nest DTO backed by a Zod schema from @nutricheck/contracts.
 *
 * We keep this in-repo rather than depending on nestjs-zod: it is sixty lines,
 * it removes a version-matrix risk across Nest / Zod / Swagger majors, and it
 * lets ZodValidationPipe map failures straight onto our RFC 9457 envelope
 * instead of translating someone else's exception shape.
 */
export interface ZodDto<T extends ZodTypeAny = ZodTypeAny> {
  new (): z.infer<T>;
  readonly zodSchema: T;
}

/**
 * Narrowed at the call boundary on purpose. zodToJsonSchema's generic parameter
 * makes the checker walk the entire schema type and hit the instantiation-depth
 * limit (TS2589) on any non-trivial contract. Only the runtime value is needed.
 */
const toJsonSchema = zodToJsonSchema as unknown as (
  schema: ZodTypeAny,
  options?: unknown,
) => Record<string, unknown>;

export function createZodDto<T extends ZodTypeAny>(schema: T): ZodDto<T> {
  class Dto {
    static readonly zodSchema = schema;
  }

  // Give Swagger something to render. Without this every body shows as `object`.
  const jsonSchema = toJsonSchema(schema, { $refStrategy: 'none' });
  const properties = (jsonSchema.properties ?? {}) as Record<string, unknown>;
  const required = new Set((jsonSchema.required as string[] | undefined) ?? []);

  for (const [name, definition] of Object.entries(properties)) {
    ApiProperty({
      ...(definition as Record<string, unknown>),
      required: required.has(name),
    })(Dto.prototype, name);
  }

  return Dto as unknown as ZodDto<T>;
}

export function isZodDto(value: unknown): value is ZodDto {
  return (
    typeof value === 'function' &&
    'zodSchema' in (value as unknown as Record<string, unknown>)
  );
}
