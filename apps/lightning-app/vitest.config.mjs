import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'lightning-app',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apps/lightning-app',
      provider: 'v8',
    },
  },
});
