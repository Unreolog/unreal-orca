import type {
  AddWorktreeOptions,
  AddWorktreeResult
} from '../../git/worktrees/worktree-operation-options'
import {
  gitExecOptions,
  resolveWorktreeAddTimeoutMs
} from '../../git/worktrees/worktree-operation-options'
import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'
import { listWorktreesStrict } from '../../git/worktrees/catalog/worktree-listing'
import { areWorktreePathsEqual } from '../../git/worktrees/catalog/worktree-path-comparison'
import {
  configurePushAutoSetupRemote,
  persistWorktreeCreationBase,
  resolveWorktreeAddBaseContext,
  trackSameNameRemoteBase
} from '../../git/worktrees/creation/worktree-add'
import { runWithGitReadCacheInvalidation } from '../../git/source-control/git-read-cache-invalidation'
import { bumpWorktreeScanGeneration } from '../../git/worktrees/catalog/worktree-scan-cache'
import { assertNoPendingWorktreeRemovalConflict } from '../removal/worktree-removal-table'
import { checkoutPersistentPoolBranch } from './persistent-pool-checkout'
import { assertPersistentPoolProcessesStopped } from './persistent-pool-processes'

export async function reusePersistentWorktree(args: {
  repoPath: string
  worktreePath: string
  branch: string
  baseBranch: string
  refreshLocalBaseRef: boolean
  options: AddWorktreeOptions
}): Promise<AddWorktreeResult> {
  const { repoPath, worktreePath, branch, baseBranch, options } = args
  assertNoPendingWorktreeRemovalConflict(repoPath, { worktreePath, branch })
  const registered = (await listWorktreesStrict(repoPath, options)).find((worktree) =>
    areWorktreePathsEqual(worktree.path, worktreePath)
  )
  if (!registered || registered.isMainWorktree || registered.locked || registered.isSparse) {
    throw new Error(
      'This pool slot is not an unlocked, fully checked-out worktree of this project.'
    )
  }
  const topLevel = await gitExecFileAsync(
    ['rev-parse', '--show-toplevel'],
    gitExecOptions(worktreePath, options)
  )
  if (!areWorktreePathsEqual(topLevel.stdout.trim(), worktreePath)) {
    throw new Error('The pool worktree path no longer resolves to its registered checkout.')
  }
  await assertPersistentPoolProcessesStopped(worktreePath)
  const base = options.checkoutExistingBranch
    ? undefined
    : await resolveWorktreeAddBaseContext(
        repoPath,
        baseBranch,
        args.refreshLocalBaseRef,
        options,
        branch
      )
  if (options.trackRemoteBranch && !base?.effectiveBase.startsWith('refs/remotes/')) {
    throw new Error('Reuse branch requires a remote-tracking ref when the local branch is missing.')
  }
  try {
    await runWithGitReadCacheInvalidation(() =>
      checkoutPersistentPoolBranch({
        branch,
        base: base?.effectiveBaseOid ?? base?.effectiveBase ?? baseBranch,
        checkoutExistingBranch: options.checkoutExistingBranch,
        exec: (command) =>
          gitExecFileAsync(command, {
            ...gitExecOptions(worktreePath, options),
            admissionClass: 'checkout',
            timeout: resolveWorktreeAddTimeoutMs()
          })
      })
    )
    if (base) {
      await persistWorktreeCreationBase(worktreePath, branch, base.effectiveBase, options)
      await trackSameNameRemoteBase(worktreePath, branch, baseBranch, base.effectiveBase, options)
      await configurePushAutoSetupRemote(worktreePath, options)
    }
    const refreshed = await base?.pendingLocalBaseRefRefresh
    base?.updateCheckedOutLocalBase?.()
    return {
      ...(base?.localBaseRefUpdateSuggestion
        ? { localBaseRefUpdateSuggestion: base.localBaseRefUpdateSuggestion }
        : {}),
      ...(refreshed ? { localBaseRefRefresh: refreshed } : {})
    }
  } catch (error) {
    await base?.pendingLocalBaseRefRefresh
    throw error
  } finally {
    bumpWorktreeScanGeneration(repoPath)
  }
}
