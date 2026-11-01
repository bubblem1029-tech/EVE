import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tsc emits CommonJS copies of colocated source tests. Run the source once,
    // rather than loading require('vitest') from a built artifact as well.
    exclude: [...configDefaults.exclude, 'dist/**'],
  },
});
