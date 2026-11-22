import type { Worktree } from '../../../shared/worktree/types'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { isWslUncPath } from '../../../shared/file-access/wsl-paths'
import { isFolderRepo } from '../../../shared/repository/repo-kind'
import { worktreeWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { closeStructuredAgentSessionChild } from '../../runtime/agent-session/lifecycle/structured-agent-session-close'
import { observeStructuredSession } from '../../runtime/orchestration/terminal-authority/structured-sessions/structured-worker-authority'
import { workspaceLifecycleKey } from '../../runtime/workspaces/lifecycle/workspace-lifecycle-commands'
import {
  readWorktreeMetaForHost,
  hostWorktreeTargetForRepo
} from '../../persistence/host-qualified-worktree-meta'
import { requireRepoLocalGitRoute } from '../execution-host/repo-execution-host'
import { getLocalProjectWorktreeGitOptions } from '../execution-host/project-runtime-git-options'
import { assertNoProjectWorktreeCreate } from '../creation/worktree-create-in-flight'
import { assertNoPendingWorktreeRemovalConflict } from '../removal/worktree-removal-table'
import { assertWslMoveRepoWritable } from '../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'
import { listWorktreesStrict } from '../../git/worktrees/catalog/worktree-listing'
import { areWorktreePathsEqual } from '../../git/worktrees/catalog/worktree-path-comparison'
import { holdPersistentPoolSlot } from './persistent-worktree-pool'
import { assertPersistentPoolCheckoutClean } from './persistent-pool-checkout'
import { assertPersistentPoolProcessesStopped } from './persistent-pool-processes'
import { retirePersistentPoolTask } from './persistent-pool-release-steps'
import { assertPersistentPoolRetiredState } from './persistent-pool-retirement-proof'
import {
  closePersistentPoolTabs,
  waitForPersistentPoolRetirement
} from './persistent-pool-tab-retirement'
import { listClientUnsavedEditorWorktreeIds } from '../cleanup/workspace-cleanup-client-unsaved-editors'
import { worktreeIdentityKey } from '../../../shared/worktree/id'

export async function releasePersistentWorktree(
  runtime: OrcaRuntimeService,
  selector: string,
  requested: { slot: number; state: 'available' },
  expectedInstanceId?: string,
  expectedHostId?: ExecutionHostId
): Promise<Worktree> {
  if (
    !Number.isSafeInteger(requested.slot) ||
    requested.slot < 1 ||
    requested.state !== 'available'
  ) {
    throw new Error('Invalid persistent worktree pool slot.')
  }
  const worktree = await runtime.showManagedWorktree(selector, expectedHostId)
  const store = runtime.requireStore()
  const repo = worktree.hostId
    ? store.getRepoForHost?.(worktree.repoId, worktree.hostId)
    : store.getRepo(worktree.repoId)
  if (!repo || isFolderRepo(repo)) {
    throw new Error('A pool slot must belong to a tracked Git project on this host.')
  }
  requireRepoLocalGitRoute(repo)
  const gitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  if (gitOptions.wslDistro || isWslUncPath(worktree.path)) {
    throw new Error('Returning WSL worktrees to the pool is not supported on this host.')
  }
  if (!store.runDurableMutation || !store.flushPendingOrThrowAsync) {
    throw new Error('Durable workspace persistence is unavailable.')
  }
  const hostId = getRepoExecutionHostId(repo)
  const target = hostWorktreeTargetForRepo(worktree.id, repo)
  const initialMeta = readWorktreeMetaForHost(store, worktree.id, hostId)
  const incarnation = expectedInstanceId
  if (!incarnation) {
    throw new Error('The pool workspace has no task identity. Refresh before returning it.')
  }
  const unlock = holdPersistentPoolSlot(repo, requested.slot)
  try {
    const assertAuthority = (): void => {
      const meta = readWorktreeMetaForHost(store, worktree.id, hostId)
      if (
        meta?.persistentPool?.slot !== requested.slot ||
        meta.persistentPool.state !== 'active' ||
        meta.instanceId !== incarnation
      ) {
        throw new Error('This pool task changed. Refresh before returning it.')
      }
      assertWslMoveRepoWritable(store, repo)
      assertNoProjectWorktreeCreate(repo)
      assertNoPendingWorktreeRemovalConflict(repo.path, { worktreePath: worktree.path })
      const hint = runtime.workspaceLifecycle?.hints()[workspaceLifecycleKey(hostId, worktree.id)]
      if (hint) {
        throw new Error(
          'A workspace lifecycle operation is still pending. Wait before returning it.'
        )
      }
      const key = worktreeWorkspaceKey(worktree.id)
      if (
        Object.values(store.getAllWorktreeLineage?.() ?? {}).some(
          (edge) =>
            edge.parentWorktreeId === worktree.id && edge.parentWorktreeInstanceId === incarnation
        ) ||
        Object.values(store.getAllWorkspaceLineage?.() ?? {}).some(
          (edge) =>
            edge.parentWorkspaceKey === key &&
            (!edge.parentInstanceId || edge.parentInstanceId === incarnation)
        ) ||
        Object.values(store.getAllCrossStoreWorkspaceLineage?.() ?? {}).some(
          (edge) => edge.parent.workspaceKey === key && edge.parent.instanceId === incarnation
        )
      ) {
        throw new Error('Detach this task’s child workspaces before returning it to the pool.')
      }
    }
    const preflight = async (): Promise<void> => {
      assertAuthority()
      const saved = runtime.getWorkspaceSessionForWorktree(worktree.id)
      if (
        saved?.openFilesByWorktree?.[worktree.id]?.some(
          (file) => file.dirtyDraftContent !== undefined
        ) ||
        [...listClientUnsavedEditorWorktreeIds(runtime)].some(
          (id) => worktreeIdentityKey(id) === worktreeIdentityKey(worktree.id)
        )
      ) {
        throw new Error('Save your editor changes before returning this worktree to the pool.')
      }
      const tabs = await runtime.listMobileSessionTabs(`id:${worktree.id}`, undefined, {
        includeAgentSenders: false
      })
      if (tabs.tabs.some((tab) => tab.type !== 'terminal' && tab.type !== 'agent-session')) {
        throw new Error('Close editor and browser tabs before returning this worktree to the pool.')
      }
      const registered = (await listWorktreesStrict(repo.path, gitOptions)).find((row) =>
        areWorktreePathsEqual(row.path, worktree.path)
      )
      if (
        !registered ||
        registered.isMainWorktree ||
        registered.isBare ||
        registered.isSparse ||
        registered.locked ||
        registered.removing ||
        registered.prunable
      ) {
        throw new Error('Only an unlocked, fully checked-out pool worktree can be returned.')
      }
      const root = await gitExecFileAsync(['rev-parse', '--show-toplevel'], {
        cwd: worktree.path,
        timeout: 30_000
      })
      if (!areWorktreePathsEqual(root.stdout.trim(), registered.path)) {
        throw new Error('The pool path no longer resolves to its registered checkout.')
      }
      await assertPersistentPoolCheckoutClean((args) =>
        gitExecFileAsync(args, { cwd: worktree.path, timeout: 30_000 })
      )
      await assertPersistentPoolProcessesStopped(worktree.path)
      assertAuthority()
    }
    await runtime.ensureStructuredAgentSessionHost()
    const host = getStructuredAgentSessionHost()
    if (!host) {
      throw new Error('Native chat retirement is unavailable.')
    }
    const inventory = await runtime.listWorkspaceStructuredSessions(worktree.id)
    if (inventory.hasUnreadable) {
      throw new Error(
        'This workspace has unreadable native chats. Their retirement cannot be verified.'
      )
    }
    const assertRetiredState = (): void =>
      assertPersistentPoolRetiredState(runtime, host, worktree.id)
    const verifyRetired = async (): Promise<void> => {
      const current = await runtime.listWorkspaceStructuredSessions(worktree.id)
      if (
        current.hasUnreadable ||
        getStructuredAgentSessionHost() !== host ||
        current.sessionIds.some(
          (id) => host.isSessionTabVisible(id) || observeStructuredSession(id).status !== 'exited'
        )
      ) {
        throw new Error('Native chat retirement is incomplete. The slot remains active.')
      }
      const snapshot = await runtime.listMobileSessionTabs(`id:${worktree.id}`, undefined, {
        includeAgentSenders: false
      })
      if (snapshot.tabs.length > 0) {
        throw new Error(
          'Workspace tab retirement is incomplete. The slot remains active; retry after tabs close.'
        )
      }
      assertRetiredState()
    }
    await retirePersistentPoolTask({
      preflight,
      retire: async () => {
        const slept = await host.sleepWorkspace(worktree.id, false)
        if (slept.failures?.length) {
          throw new Error('Native chats could not be stopped. The slot remains active.')
        }
        const terminalClose = await runtime.closeTerminalsForWorktree(`id:${worktree.id}`)
        if (terminalClose.ptyStopVerdict || !terminalClose.retiredSurfaces) {
          throw new Error('Terminal shutdown could not be verified. The slot remains active.')
        }
        await closePersistentPoolTabs(runtime, worktree.id)
        for (const sessionId of new Set([...inventory.sessionIds, ...slept.stoppedSessionIds])) {
          const closed = await closeStructuredAgentSessionChild(sessionId, { runtime })
          if (!closed.stopped) {
            throw new Error(closed.reason ?? 'Native chat shutdown could not be verified.')
          }
        }
        await store.flushPendingOrThrowAsync!()
        await waitForPersistentPoolRetirement(verifyRetired)
      },
      verifyRetired,
      commit: async () => {
        const refusal = await store.runDurableMutation!<Error | undefined>(() => {
          try {
            assertAuthority()
            assertRetiredState()
          } catch (error) {
            return {
              value: error instanceof Error ? error : new Error(String(error)),
              persist: false
            }
          }
          const sessions = host.deps.store
            .listConversations()
            .filter((record) => record.location.workspaceId === worktree.id)
            .map((record) => record.sessionId)
          store.setWorktreeMeta(target, {
            persistentPool: { slot: requested.slot, state: 'available' },
            persistentPoolRetiredSessions: [
              ...new Set([
                ...(initialMeta?.persistentPoolRetiredSessions ?? []),
                ...inventory.sessionIds,
                ...sessions
              ])
            ],
            isArchived: true,
            preserveBranchOnDelete: true
          })
          return {
            value: undefined,
            rollback: () => {
              store.setWorktreeMeta(target, {
                persistentPool: initialMeta?.persistentPool,
                persistentPoolRetiredSessions: initialMeta?.persistentPoolRetiredSessions,
                isArchived: initialMeta?.isArchived,
                preserveBranchOnDelete: initialMeta?.preserveBranchOnDelete
              })
            }
          }
        })
        if (refusal) {
          throw refusal
        }
      }
    })
    runtime.invalidateResolvedWorktreeCache()
    runtime.invalidateWorktreeScanCacheForRepo(repo.id)
    runtime.notifyWorktreesChanged(repo.id)
    return await runtime.showManagedWorktree(`id:${worktree.id}`, hostId)
  } finally {
    unlock()
  }
}
