import { ApiProperty } from '@nestjs/swagger';
import type { ZodTypeAny, z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * A Nest DTO backed by a Zod schema from @nutricheck/contracts.
 *
 * We keep this in-repo rather than depending on nestjs-zod: it is a hundred
 * lines, it removes a version-matrix risk across Nest / Zod / Swagger majors,
 * and it lets ZodValidationPipe map failures straight onto our RFC 9457
 * envelope instead of translating another library's exception shape.
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

type Fragment = Record<string, unknown>;

/** Keys that mean the same thing in JSON Schema and OpenAPI 3.1. */
const PASSTHROUGH = [
  'description',
  'format',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'default',
] as const;

/**
 * Translate a JSON Schema fragment into ApiProperty options.
 *
 * The important part is that the result ALWAYS carries an explicit `type` (or
 * `oneOf`). A Zod DTO class has no real properties, so there is no
 * `design:type` metadata for Swagger to reflect on — handed a fragment with no
 * type, its schema factory decides the property must be a class reference and
 * throws "A circular dependency has been detected". A nullable field is exactly
 * that case, because zod-to-json-schema emits it as an anyOf with no top-level
 * type.
 */
function toApiProperty(fragment: Fragment): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const key of PASSTHROUGH) {
    if (fragment[key] !== undefined) out[key] = fragment[key];
  }

  // `type: ["string", "null"]` — the JSON Schema 2020-12 spelling of nullable.
  if (Array.isArray(fragment.type)) {
    const types = fragment.type as string[];
    const concrete = types.filter((t) => t !== 'null');
    return {
      ...out,
      type: concrete[0] ?? 'object',
      ...(types.includes('null') ? { nullable: true } : {}),
    };
  }

  const union = (fragment.anyOf ?? fragment.oneOf) as Fragment[] | undefined;
  if (union) {
    const nullable = union.some((member) => member.type === 'null');
    const concrete = union.filter((member) => member.type !== 'null');

    // A nullable single type collapses to that type plus nullable, which is
    // what OpenAPI consumers expect to see.
    if (concrete.length === 1) {
      return { ...out, ...toApiProperty(concrete[0]!), ...(nullable ? { nullable: true } : {}) };
    }
    return {
      ...out,
      oneOf: concrete.map(toApiProperty),
      ...(nullable ? { nullable: true } : {}),
    };
  }

  if (fragment.enum) {
    return {
      ...out,
      enum: fragment.enum,
      type: typeof (fragment.enum as unknown[])[0] === 'number' ? 'number' : 'string',
    };
  }

  if (fragment.type === 'array') {
    return {
      ...out,
      type: 'array',
      items: fragment.items ? toApiProperty(fragment.items as Fragment) : { type: 'object' },
    };
  }

  if (typeof fragment.type === 'string') {
    return { ...out, type: fragment.type };
  }

  // Unions of objects, records, intersections and anything else the translator
  // does not model. `object` is imprecise but it renders, and — unlike an
  // untyped fragment — it cannot take the process down at boot.
  return { ...out, type: 'object' };
}

export function createZodDto<T extends ZodTypeAny>(schema: T): ZodDto<T> {
  class Dto {
    static readonly zodSchema = schema;
  }

  const jsonSchema = toJsonSchema(schema, { $refStrategy: 'none', target: 'openApi3' });
  const properties = (jsonSchema.properties ?? {}) as Record<string, Fragment>;
  const required = new Set((jsonSchema.required as string[] | undefined) ?? []);

  for (const [name, fragment] of Object.entries(properties)) {
    ApiProperty({
      ...toApiProperty(fragment),
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
