import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the web app — pure logic and components rendered to a string.
 *
 * Two settings that Next handles for itself and vitest does not:
 *
 *   - JSX. `tsconfig.json` says `"jsx": "preserve"`, because Next compiles JSX
 *     with its own transform and wants it left alone. Vitest reads that setting
 *     too, leaves the JSX in, and then cannot parse it. The automatic runtime
 *     here is what React 19 and Next both use, so a component renders under test
 *     exactly as it does in the app.
 *
 *   - The `@/` alias, which Next resolves from `paths` in the tsconfig and
 *     vitest does not.
 *
 * No DOM. Components are rendered with `react-dom/server` in plain Node, which
 * is enough to assert what a screen SHOWS for a given state without adding
 * jsdom and a testing library for it. Interaction — clicks, effects, fetching —
 * is out of reach of this setup on purpose; see the specs for what each covers.
 */
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.spec.{ts,tsx}'],
    environment: 'node',
  },
});
