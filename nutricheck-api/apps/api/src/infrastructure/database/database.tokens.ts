/**
 * Injection tokens live apart from the module so the health indicator can
 * import them without creating a module <-> indicator import cycle.
 */
export const DATABASE = Symbol('DATABASE');
export const DATABASE_POOL = Symbol('DATABASE_POOL');
