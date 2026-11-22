import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'
import { RepoUpdate } from '../../../shared/rpc-contract/projects/repo-params'
import { hydrateRepo } from './repo-hydration'
import { RepoUpdatePersistenceOperations } from './repo-update-operations'
vi.mock('../../github/accounts/gh-account-token', () => ({
  invalidateGhAccountTokenCache: vi.fn()
}))

function fixture(kind: Repo['kind'] = 'git') {
  const repo: Repo = {
    id: 'repo',
    path: '/repos/example',
    displayName: 'Example',
    badgeColor: '#000000',
    addedAt: 0,
    kind
  }
  const state = { repos: [repo], projectGroups: [], worktreeMeta: {} }
  const scheduleSave = vi.fn()
  const operations = new RepoUpdatePersistenceOperations({
    state,
    scheduleSave,
    bumpLocalWorktreeScanGeneration: vi.fn(),
    syncProjectHostSetupCompatibilityState: vi.fn(),
    hydrateRepo: (row) => hydrateRepo(row, new Map())
  })
  return { repo, operations, scheduleSave }
}

describe('persistent pool project settings', () => {
  it('persists RPC updates and reloads the configured pool, including explicit off', () => {
    const { repo, operations } = fixture()
    for (const size of [3, 16, 1, 0]) {
      const params = RepoUpdate.parse({ repo: repo.id, updates: { worktreePoolSize: size } })
      const result = operations.updateRepo(repo, {
        worktreePoolSize: params.updates.worktreePoolSize
      })
      expect(result?.worktreePoolSize).toBe(size)
      expect(hydrateRepo(JSON.parse(JSON.stringify(repo)), new Map()).worktreePoolSize).toBe(size)
    }
  })

  it.each([-1, 17, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid pool update without changing the saved setting: %s',
    (size) => {
      const { repo, operations, scheduleSave } = fixture()
      repo.worktreePoolSize = 3
      expect(() => operations.updateRepo(repo, { worktreePoolSize: size })).toThrow(
        'Worktree pool size must be an integer from 0 to 16.'
      )
      expect(repo.worktreePoolSize).toBe(3)
      expect(scheduleSave).not.toHaveBeenCalled()
      expect(
        RepoUpdate.safeParse({ repo: repo.id, updates: { worktreePoolSize: size } }).success
      ).toBe(false)
    }
  )

  it('does not opt existing projects into a pool and disables malformed persisted settings', () => {
    const { repo } = fixture()
    expect(hydrateRepo(repo, new Map())).not.toHaveProperty('worktreePoolSize')
    expect(hydrateRepo({ ...repo, worktreePoolSize: 17 }, new Map()).worktreePoolSize).toBe(0)
    expect(hydrateRepo({ ...repo, worktreePoolSize: 1.5 }, new Map()).worktreePoolSize).toBe(0)
  })

  it('refuses to enable a Git worktree pool on a folder project', () => {
    const { repo, operations, scheduleSave } = fixture('folder')
    expect(() => operations.updateRepo(repo, { worktreePoolSize: 3 })).toThrow(
      'Folder projects do not support persistent worktree pools.'
    )
    expect(repo).not.toHaveProperty('worktreePoolSize')
    expect(scheduleSave).not.toHaveBeenCalled()
  })
})
