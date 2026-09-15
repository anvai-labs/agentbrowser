import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each file launches native Firefox. Qualification measures its behavior,
    // not whether several fresh processes win a shared-host startup race.
    fileParallelism: false,
  },
});
