import { getFreshStrictProcessTableSnapshot } from '../../../shared/process-observation/tables/process-table-snapshot-reader'
import { readWindowsProcessTableFresh } from '../../windows/windows-process-table'
import { assertNoPersistentPoolProcess } from './persistent-pool-release-steps'

export async function assertPersistentPoolProcessesStopped(worktreePath: string): Promise<void> {
  const rows =
    process.platform === 'win32'
      ? await readWindowsProcessTableFresh()
      : await getFreshStrictProcessTableSnapshot()
  // Windows supplies argv, not cwd; only an explicit slot path proves this association.
  assertNoPersistentPoolProcess(worktreePath, rows, process.platform)
}
