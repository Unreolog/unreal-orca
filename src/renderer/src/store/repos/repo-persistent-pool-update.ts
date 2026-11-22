import { WORKTREE_PERSISTENT_POOL_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { persistentWorktreePoolSize } from '../../../../shared/worktree/persistent-worktree-pool'
import { assertRuntimeEnvironmentCapability } from '../../runtime/rpc/compatibility/runtime-capability-proof'
import { translate } from '@/i18n/i18n'

export async function assertRepoPersistentPoolUpdate(
  target: RuntimeClientTarget,
  size: number | undefined
): Promise<void> {
  if (size === undefined) {
    return
  }
  if (size !== 0 && persistentWorktreePoolSize(size) === 0) {
    throw new Error('Worktree pool size must be an integer from 0 to 16.')
  }
  if (target.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      WORKTREE_PERSISTENT_POOL_RUNTIME_CAPABILITY,
      translate(
        'worktree.pool.configureUpdateRuntime',
        'Update the remote runtime to configure persistent worktree pools.'
      )
    )
  }
}
