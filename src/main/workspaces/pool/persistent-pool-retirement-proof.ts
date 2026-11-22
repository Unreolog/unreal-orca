import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { observeStructuredSession } from '../../runtime/orchestration/terminal-authority/structured-sessions/structured-worker-authority'

export function assertPersistentPoolRetiredState(
  runtime: OrcaRuntimeService,
  host: StructuredAgentSessionHost,
  worktreeId: string
): void {
  if (
    getStructuredAgentSessionHost() !== host ||
    host.deps.store
      .listConversations()
      .some(
        (record) =>
          record.location.workspaceId === worktreeId &&
          (host.isSessionTabVisible(record.sessionId) ||
            observeStructuredSession(record.sessionId).status !== 'exited')
      )
  ) {
    throw new Error('Native chat retirement is incomplete. The slot remains active.')
  }
  const saved = runtime.getWorkspaceSessionForWorktree(worktreeId)
  if (
    !saved ||
    (saved.tabsByWorktree[worktreeId]?.length ?? 0) > 0 ||
    (saved.unifiedTabs?.[worktreeId]?.length ?? 0) > 0 ||
    Object.values(saved.sleepingAgentSessionsByPaneKey ?? {}).some(
      (record) => record.worktreeId === worktreeId
    )
  ) {
    throw new Error(
      'Workspace tab retirement is incomplete. The slot remains active; retry after tabs close.'
    )
  }
}
