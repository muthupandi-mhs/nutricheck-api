import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgres://nutricheck:local@localhost:5432/nutricheck',
  },
  // Extensions are created by docker/initdb, not by a generated migration —
  // CREATE EXTENSION needs privileges the app role should not hold in production.
  extensionsFilters: ['postgis'],
  verbose: true,
  strict: true,
});
