import { useState } from 'react'
import { toast } from 'sonner'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { persistentWorktreePoolSize } from '../../../../../../shared/worktree/persistent-worktree-pool'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { useTranslate } from '@/i18n/use-translate'

export function RepositoryPersistentWorktreePoolSetting({
  repo,
  updateRepo,
  forceVisible
}: {
  repo: Repo
  updateRepo: (repoId: string, updates: Pick<Repo, 'worktreePoolSize'>) => void | Promise<boolean>
  forceVisible: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [pending, setPending] = useState(false)
  const poolSize = persistentWorktreePoolSize(repo.worktreePoolSize)
  const title = t('worktree.pool.settingTitle', 'Persistent worktree pool')
  const description = t(
    'worktree.pool.settingDescription',
    'Reuse fixed worktree directories for new tasks and keep local build outputs.'
  )
  const save = async (worktreePoolSize: number): Promise<void> => {
    if (pending) {
      return
    }
    setPending(true)
    try {
      if ((await updateRepo(repo.id, { worktreePoolSize })) === false) {
        throw new Error(
          t(
            'worktree.pool.saveFailed',
            'Could not save the worktree pool setting. Update the owning runtime and try again.'
          )
        )
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={[repo.displayName, 'pool', 'persistent', 'reuse', 'build', 'cache', 'slots']}
      className="space-y-2 py-3"
      forceVisible={forceVisible}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`worktree-pool-${repo.id}`} className="text-sm font-semibold">
            {title}
          </Label>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Switch
          id={`worktree-pool-${repo.id}`}
          checked={poolSize > 0}
          disabled={pending}
          onCheckedChange={(enabled) => void save(enabled ? 3 : 0)}
        />
      </div>
      {poolSize > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={`worktree-pool-size-${repo.id}`}>
            {t('worktree.pool.size', 'Pool size')}
          </Label>
          <Select
            value={String(poolSize)}
            disabled={pending}
            onValueChange={(value) => void save(Number(value))}
          >
            <SelectTrigger
              id={`worktree-pool-size-${repo.id}`}
              size="sm"
              className="h-8 w-24 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 16 }, (_, index) => index + 1).map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {t(
          'worktree.pool.releaseHint',
          'Use Return to pool when a task is done. Turning this off keeps existing directories and branches.'
        )}
      </p>
    </SearchableSetting>
  )
}
