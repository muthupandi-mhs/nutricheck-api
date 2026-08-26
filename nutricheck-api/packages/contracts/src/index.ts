/**
 * @nutricheck/contracts — the wire contract.
 *
 * One Zod definition per shape, consumed three ways:
 *   • the API turns it into a Nest DTO (nestjs-zod) and an OpenAPI schema
 *   • the resolver turns some of them into Anthropic structured-output formats
 *   • the React Native client infers its TypeScript types from it
 *
 * There is no second definition of any of these shapes anywhere in the repo.
 */
export * from './common';
export * from './text';
export * from './nutrition';
export * from './food';
export * from './resolve';
export * from './logs';
export * from './profile';
export * from './auth';
export * from './meals';
export * from './suggestions';
export * from './transcription';
