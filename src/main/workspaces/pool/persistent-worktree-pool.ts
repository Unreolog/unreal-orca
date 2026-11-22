import type { Repo } from '../../../shared/repository/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { persistentWorktreePoolSize } from '../../../shared/worktree/persistent-worktree-pool'
import { getRepoExecutionHostId } from '../../../shared/execution-host/execution-host'
import {
  hostWorktreeTargetForRepo,
  readWorktreeMetaForHost
} from '../../persistence/host-qualified-worktree-meta'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'

export type PersistentPoolStore = Pick<
  RuntimeStore,
  'getAllWorktreeMeta' | 'getAllWorktreeMetaForHost' | 'setWorktreeMeta'
> &
  Pick<RuntimeStore, 'runDurableMutation'>

export type PersistentPoolClaim = {
  slot: number
  worktreePath: string
  reused: boolean
  release: () => void
  allowStartup: () => void
  abortUnmaterialized: () => Promise<void>
}

const claimedSlots = new Map<string, 'allocating' | 'starting' | 'releasing'>()

export function holdPersistentPoolSlot(
  repo: Repo,
  slot: number,
  phase: 'allocating' | 'releasing' = 'releasing'
): () => void {
  const key = `${getRepoExecutionHostId(repo)}:${repo.id}:${slot}`
  if (claimedSlots.has(key)) {
    throw new Error('This worktree pool slot is already changing tasks. Wait for it to finish.')
  }
  claimedSlots.set(key, phase)
  return () => claimedSlots.delete(key)
}

export function assertPersistentPoolSpawnAllowed(
  repoId: string | undefined,
  meta: WorktreeMeta | undefined,
  hostId: string,
  sessionIds: readonly string[] = []
): void {
  if (!meta?.persistentPool) {
    return
  }
  if (!repoId) {
    throw new Error('This pool worktree has no project identity.')
  }
  if (sessionIds.some((id) => meta.persistentPoolRetiredSessions?.includes(id))) {
    throw new Error(
      'This chat belongs to an earlier pool task. Read its history or start a new chat.'
    )
  }
  const phase = claimedSlots.get(`${hostId}:${repoId}:${meta.persistentPool.slot}`)
  if (meta.persistentPool.state !== 'active' || phase === 'allocating' || phase === 'releasing') {
    throw new Error(
      'This pool worktree is available or changing tasks. Start a new task with + first.'
    )
  }
}

export function assertPersistentPoolTargetSpawnAllowed(
  store: RuntimeStore | null | undefined,
  target: HostWorktreeTarget
): void {
  if (store) {
    assertPersistentPoolSpawnAllowed(
      getRepoIdFromWorktreeId(target.id),
      readWorktreeMetaForHost(store, target.id, target.hostId),
      target.hostId
    )
  }
}

export async function claimPersistentWorktree(args: {
  repo: Repo
  store: PersistentPoolStore
  makePath: (name: string) => string
  pathExists: (path: string) => Promise<boolean>
}): Promise<PersistentPoolClaim | undefined> {
  const size = persistentWorktreePoolSize(args.repo.worktreePoolSize)
  if (size === 0) {
    return undefined
  }
  if (!args.store.runDurableMutation) {
    throw new Error('Durable workspace persistence is required to reserve a worktree pool slot.')
  }
  const hostId = getRepoExecutionHostId(args.repo)
  const prefix = `${args.repo.id}::`
  const entries = Object.entries(
    args.store.getAllWorktreeMetaForHost?.(hostId) ?? args.store.getAllWorktreeMeta()
  ).filter(([id, meta]) => id.startsWith(prefix) && (!meta.hostId || meta.hostId === hostId))
  for (let slot = 1; slot <= size; slot += 1) {
    const key = `${hostId}:${args.repo.id}:${slot}`
    if (claimedSlots.has(key)) {
      continue
    }
    const matches = entries.filter(([, meta]) => meta.persistentPool?.slot === slot)
    if (matches.length > 1) {
      throw new Error('The worktree pool has conflicting slot records. Resolve them before reuse.')
    }
    const existing = matches[0]
    if (existing && existing[1].persistentPool?.state !== 'available') {
      continue
    }
    const release = holdPersistentPoolSlot(args.repo, slot, 'allocating')
    try {
      const worktreePath = existing
        ? existing[0].slice(prefix.length)
        : args.makePath(`pool-${slot}`)
      const exists = await args.pathExists(worktreePath)
      if (existing ? !exists : exists) {
        throw new Error(
          existing
            ? 'An available pool worktree is missing. Remove its stale registration before reuse.'
            : `The pool path already exists and is not a pool slot: ${worktreePath}`
        )
      }
      // A crash during checkout leaves an occupied slot, never a falsely available directory.
      const target = hostWorktreeTargetForRepo(`${prefix}${worktreePath}`, args.repo)
      await args.store.runDurableMutation(() => {
        args.store.setWorktreeMeta(target, {
          persistentPool: { slot, state: 'active' },
          preserveBranchOnDelete: true
        })
        return {
          value: undefined,
          rollback: () => {
            args.store.setWorktreeMeta(target, {
              persistentPool: existing?.[1].persistentPool,
              preserveBranchOnDelete: existing?.[1].preserveBranchOnDelete
            })
          }
        }
      })
      return {
        slot,
        worktreePath,
        reused: Boolean(existing),
        allowStartup: () => claimedSlots.set(key, 'starting'),
        abortUnmaterialized: async () => {
          if (existing || (await args.pathExists(worktreePath))) {
            return
          }
          await args.store.runDurableMutation!(() => {
            const current = (args.store.getAllWorktreeMetaForHost?.(hostId) ??
              args.store.getAllWorktreeMeta())[target.id]
            if (
              current?.persistentPool?.slot === slot &&
              current.persistentPool.state === 'active'
            ) {
              args.store.setWorktreeMeta(target, {
                persistentPool: undefined,
                preserveBranchOnDelete: undefined
              })
            }
            return { value: undefined }
          })
        },
        release
      }
    } catch (error) {
      release()
      throw error
    }
  }
  throw new Error(
    `All ${size} worktree pool slots are occupied. Return a finished task to the pool.`
  )
}

export function persistentPoolTaskMetadata(slot: number): Partial<WorktreeMeta> {
  return {
    persistentPool: { slot, state: 'active' },
    preserveBranchOnDelete: true,
    isArchived: false,
    archivedCheckout: undefined,
    comment: '',
    isPinned: false,
    isUnread: false,
    linkedIssue: null,
    linkedPR: null,
    suppressedGitHubPR: null,
    linkedLinearIssue: null,
    linkedLinearIssueWorkspaceId: null,
    linkedLinearIssueOrganizationUrlKey: null,
    linkedGitLabIssue: null,
    linkedGitLabMR: null,
    linkedBitbucketPR: null,
    linkedAzureDevOpsPR: null,
    linkedGiteaPR: null,
    linkedWorkItem: null,
    linkedItems: [],
    linkedTaskSourceContext: null,
    pushTarget: undefined,
    automationProvenance: undefined,
    cliProvenance: undefined,
    externalConversations: undefined,
    pendingFirstAgentMessageRename: false,
    firstAgentMessageRenameError: null,
    diffComments: undefined,
    mobileDiffReview: undefined,
    manualOrder: undefined,
    createdWithAgent: undefined,
    sparseDirectories: undefined,
    sparseBaseRef: undefined,
    sparsePresetId: undefined,
    workspaceStatus: undefined
  }
}
