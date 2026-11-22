import { expect, it } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { WORKTREE_META_PERSISTED_DEFAULTS } from '../../../shared/worktree/metadata/meta-persisted-defaults'
import {
  assertPersistentPoolSpawnAllowed,
  claimPersistentWorktree,
  holdPersistentPoolSlot,
  type PersistentPoolStore
} from './persistent-worktree-pool'

let repositorySequence = 0

function fixture(size = 2) {
  const repo: Repo = {
    id: `pool-test-${++repositorySequence}`,
    path: '/project',
    displayName: 'Project',
    badgeColor: '#737373',
    addedAt: 1,
    worktreePoolSize: size
  }
  const metadata: Record<string, WorktreeMeta> = {}
  const store: PersistentPoolStore = {
    getAllWorktreeMeta: () => metadata,
    getAllWorktreeMetaForHost: () => metadata,
    runDurableMutation: async (mutate) => mutate().value,
    setWorktreeMeta: (target, updates) => {
      const meta: WorktreeMeta = {
        ...WORKTREE_META_PERSISTED_DEFAULTS,
        ...(metadata[target.id] ?? {
          displayName: '',
          comment: '',
          isUnread: false,
          sortOrder: 0,
          lastActivityAt: 0
        }),
        ...updates,
        hostId: target.hostId
      }
      metadata[target.id] = meta
      return meta
    }
  }
  const paths = new Set<string>()
  return {
    repo,
    metadata,
    paths,
    store,
    args: {
      repo,
      store,
      makePath: (name: string) => `/workspaces/${name}`,
      pathExists: async (path: string) => paths.has(path)
    }
  }
}

it('reserves different permanent slots during simultaneous creates and refuses pool overflow', async () => {
  const { args } = fixture()
  const [first, second] = await Promise.all([
    claimPersistentWorktree(args),
    claimPersistentWorktree(args)
  ])
  try {
    expect(first?.worktreePath).toBe('/workspaces/pool-1')
    expect(second?.worktreePath).toBe('/workspaces/pool-2')
    await expect(claimPersistentWorktree(args)).rejects.toThrow(
      'All 2 worktree pool slots are occupied'
    )
  } finally {
    first?.release()
    second?.release()
  }
})

it('reuses only an explicitly available slot and persists occupancy before returning it', async () => {
  const { args, paths, metadata, repo } = fixture(1)
  const first = await claimPersistentWorktree(args)
  first?.release()
  paths.add('/workspaces/pool-1')
  await expect(claimPersistentWorktree(args)).rejects.toThrow('occupied')
  const id = `${repo.id}::/workspaces/pool-1`
  metadata[id].persistentPool = { slot: 1, state: 'available' }
  const next = await claimPersistentWorktree(args)
  try {
    expect(next?.worktreePath).toBe('/workspaces/pool-1')
    expect(next?.reused).toBe(true)
    expect(metadata[id].persistentPool).toEqual({ slot: 1, state: 'active' })
  } finally {
    next?.release()
  }
})

it('does not adopt or overwrite an existing unowned directory', async () => {
  const { args, paths, metadata } = fixture(1)
  paths.add('/workspaces/pool-1')
  await expect(claimPersistentWorktree(args)).rejects.toThrow('already exists')
  expect(Object.keys(metadata)).toEqual([])
})

it('refuses a missing available checkout instead of recreating it over unknown state', async () => {
  const { args, metadata, repo } = fixture(1)
  const first = await claimPersistentWorktree(args)
  first?.release()
  metadata[`${repo.id}::/workspaces/pool-1`].persistentPool = { slot: 1, state: 'available' }
  await expect(claimPersistentWorktree(args)).rejects.toThrow('missing')
})

it('refuses agent starts until allocation is ready, while releasing, and while available', async () => {
  const { args, metadata, repo } = fixture(1)
  const claim = await claimPersistentWorktree(args)
  const id = `${repo.id}::/workspaces/pool-1`
  try {
    expect(() => assertPersistentPoolSpawnAllowed(repo.id, metadata[id], 'local')).toThrow(
      'changing tasks'
    )
    claim?.allowStartup()
    expect(() => assertPersistentPoolSpawnAllowed(repo.id, metadata[id], 'local')).not.toThrow()
  } finally {
    claim?.release()
  }
  const release = holdPersistentPoolSlot(repo, 1)
  try {
    expect(() => assertPersistentPoolSpawnAllowed(repo.id, metadata[id], 'local')).toThrow(
      'changing tasks'
    )
  } finally {
    release()
  }
  metadata[id].persistentPool = { slot: 1, state: 'available' }
  expect(() => assertPersistentPoolSpawnAllowed(repo.id, metadata[id], 'local')).toThrow(
    'available'
  )
})

it('does not return a reservation before durable persistence succeeds', async () => {
  const { args, store, metadata, repo } = fixture(1)
  const persist = store.runDurableMutation!
  store.runDurableMutation = async (mutate) => {
    const change = mutate()
    change.rollback?.()
    throw new Error('disk write failed')
  }
  await expect(claimPersistentWorktree(args)).rejects.toThrow('disk write failed')
  expect(metadata[`${repo.id}::/workspaces/pool-1`].persistentPool).toBeUndefined()
  store.runDurableMutation = persist
  const retried = await claimPersistentWorktree(args)
  try {
    expect(retried?.slot).toBe(1)
  } finally {
    retried?.release()
  }
})

it('prevents historical task chats from acquiring the reused directory', async () => {
  const { args, metadata, repo } = fixture(1)
  const claim = await claimPersistentWorktree(args)
  claim?.allowStartup()
  const meta = metadata[`${repo.id}::/workspaces/pool-1`]
  meta.persistentPoolRetiredSessions = ['old-task-chat']
  try {
    expect(() =>
      assertPersistentPoolSpawnAllowed(repo.id, meta, 'local', ['old-task-chat'])
    ).toThrow('earlier pool task')
    expect(() =>
      assertPersistentPoolSpawnAllowed(repo.id, meta, 'local', ['new-task-chat'])
    ).not.toThrow()
  } finally {
    claim?.release()
  }
})

it('releases a failed new reservation only while its directory was never materialized', async () => {
  const { args, metadata, paths, repo } = fixture(1)
  const first = await claimPersistentWorktree(args)
  await first?.abortUnmaterialized()
  first?.release()
  expect(metadata[`${repo.id}::/workspaces/pool-1`].persistentPool).toBeUndefined()
  const second = await claimPersistentWorktree(args)
  paths.add('/workspaces/pool-1')
  try {
    await second?.abortUnmaterialized()
    expect(metadata[`${repo.id}::/workspaces/pool-1`].persistentPool).toEqual({
      slot: 1,
      state: 'active'
    })
  } finally {
    second?.release()
  }
})
