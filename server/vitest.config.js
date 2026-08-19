import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The suite runs against a real PostgreSQL from docker-compose, so it needs the
// same .env a developer uses. Node's built-in loader is used rather than adding
// dotenv; it does not override variables already set in the real environment,
// which is what CI wants.
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// Forced AFTER the file is loaded, because .env sets NODE_ENV=development and
// env.js picks the database from it. Getting this wrong would point the suite -
// which truncates every table between tests - at the development database.
process.env.NODE_ENV = 'test';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    globalSetup: ['./test/globalSetup.js'],
    // One test database, and tests truncate it between cases. Parallel files
    // would truncate each other's fixtures mid-assertion.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
    },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
