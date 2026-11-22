import type { OrcaRuntimeService } from '../../runtime/orca-runtime'

type PoolTabRuntime = Pick<OrcaRuntimeService, 'listMobileSessionTabs' | 'closeMobileSessionTab'>

export async function closePersistentPoolTabs(
  runtime: PoolTabRuntime,
  worktreeId: string
): Promise<void> {
  const selector = `id:${worktreeId}`
  const snapshot = await runtime.listMobileSessionTabs(selector, undefined, {
    includeAgentSenders: false
  })
  const requested = new Set<string>()
  for (const tab of snapshot.tabs) {
    if (tab.type !== 'terminal' && tab.type !== 'agent-session') {
      throw new Error('Close editor and browser tabs before returning this worktree to the pool.')
    }
    const tabId = tab.type === 'terminal' ? tab.parentTabId : tab.id
    if (requested.has(tabId)) {
      continue
    }
    requested.add(tabId)
    const closed = await runtime.closeMobileSessionTab(selector, tabId, {
      force: false,
      reason: 'user'
    })
    if (closed.refused) {
      throw new Error(
        `Could not close workspace tab "${tab.title}" (${tabId}): ${closed.refusalReason}. The slot remains active.`
      )
    }
  }
}

export async function waitForPersistentPoolRetirement(
  verifyRetired: () => Promise<void>
): Promise<void> {
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      await verifyRetired()
      return
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
}
