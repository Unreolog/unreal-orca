import { useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { persistWorktreeMeta } from '@/store/slices/worktrees/metadata/worktree-meta-persist'
import { runtimeTargetForWorktreeOwner } from '@/store/slices/worktrees/listing/worktree-owner-target'

export function WorktreeContextMenuReturnToPoolItem({
  worktree,
  disabled,
  closeMenu
}: {
  worktree: Worktree
  disabled: boolean
  closeMenu: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const returnToPool = async (): Promise<void> => {
    if (pendingRef.current || worktree.persistentPool?.state !== 'active') {
      return
    }
    pendingRef.current = true
    setPending(true)
    closeMenu()
    let progressToast: string | number | undefined
    try {
      const approved = await confirm({
        title: t('worktree.pool.returnTitle', 'Return workspace to pool?'),
        subtitle: worktree.displayName,
        description: t(
          'worktree.pool.returnDescription',
          'Stop native chats and terminals in this workspace, then make its directory available for the next task. Commit tracked changes and close editor and browser tabs first. Files, build outputs, and branches stay on disk.'
        ),
        confirmLabel: t('worktree.pool.returnAction', 'Return to pool'),
        surface: 'security'
      })
      if (!approved) {
        return
      }
      progressToast = toast.loading(t('worktree.pool.returning', 'Returning workspace to pool...'))
      const state = useAppStore.getState()
      const target = runtimeTargetForWorktreeOwner(state, worktree.id, worktree.hostId)
      await persistWorktreeMeta(
        target,
        worktree.id,
        {
          instanceId: worktree.instanceId,
          persistentPool: { slot: worktree.persistentPool.slot, state: 'available' }
        },
        worktree.hostId,
        worktree.identity?.key
      )
      const refreshed = await useAppStore.getState().fetchWorktrees(worktree.repoId, {
        executionHostId: worktree.hostId,
        forceFresh: true,
        requireAuthoritative: true
      })
      if (!refreshed) {
        toast.error(
          t(
            'worktree.pool.refreshFailed',
            'Workspace returned to pool, but the catalog could not refresh. Refresh the project to see its current state.'
          )
        )
      } else {
        toast.success(t('worktree.pool.returned', 'Workspace returned to pool.'))
      }
    } catch (error) {
      toast.error(t('worktree.pool.returnFailed', 'Could not return workspace to pool.'), {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      if (progressToast !== undefined) {
        toast.dismiss(progressToast)
      }
      pendingRef.current = false
      setPending(false)
    }
  }
  return (
    <DropdownMenuItem disabled={disabled || pending} onSelect={() => void returnToPool()}>
      <RotateCcw className="size-3.5" />
      {t('worktree.pool.returnAction', 'Return to pool')}
    </DropdownMenuItem>
  )
}
