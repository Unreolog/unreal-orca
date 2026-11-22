import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/main/workspaces/pool/*.test.ts',
      'src/main/persistence/tracking-repos/repo-persistent-pool.test.ts'
    ],
    maxWorkers: 2
  }
})
