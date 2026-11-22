import { expect, it } from 'vitest'
import { evaluateWorkspaceCleanup } from '../../../shared/workspace-cleanup/workspace-cleanup-evaluation'

it('keeps a permanent slot even when merged and inactive cleanup rules would otherwise delete it', () => {
  expect(
    evaluateWorkspaceCleanup(
      {
        reasons: ['merged'],
        blockers: ['persistent-pool'],
        lastActivityAt: 1,
        git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 1 }
      },
      {
        source: 'global',
        inactiveActionSupported: true,
        rules: {
          merged: { enabled: true },
          unchanged: { enabled: true, afterDays: 1 },
          inactive: { enabled: true, afterDays: 1, action: 'delete' },
          automationRuns: { enabled: true },
          orchestrationWorkers: { enabled: true },
          keepWhen: 'uncommitted'
        }
      },
      Date.UTC(2026, 10, 19)
    )
  ).toEqual({ action: 'keep', cause: 'not-removable' })
})
