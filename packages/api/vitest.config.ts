import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.test.ts', '**/*.config.ts']
    }
  },
  resolve: {
    alias: {
      // Absolute (not relative-to-cwd) so this resolves whether vitest runs
      // from the repo root or from this package's own directory (the
      // pnpm -r invocation does the latter - the prior relative path was
      // silently dead for any test actually importing this package).
      '@agentbrowser/engine-playwright': fileURLToPath(
        new URL('../engine-playwright/src/index.ts', import.meta.url)
      )
    }
  }
});
