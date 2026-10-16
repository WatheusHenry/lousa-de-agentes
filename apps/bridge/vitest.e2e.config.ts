import { defineProject } from 'vitest/config';

/** `pnpm e2e`: teste ponta a ponta com GitLab (falso por padrão, ou o seu sandbox). */
export default defineProject({
  test: { name: 'bridge-e2e', environment: 'node', include: ['e2e/**/*.e2e.ts'], testTimeout: 600_000 },
});
