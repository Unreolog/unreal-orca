import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  delegatedMobileSessionTabClose,
  refusedMobileSessionTabClose
} from '../../runtime/session-lifecycle/close/mobile-session-tab-close-outcome'
import { retirePersistentPoolTask } from './persistent-pool-release-steps'
import {
  closePersistentPoolTabs,
  waitForPersistentPoolRetirement
} from './persistent-pool-tab-retirement'

function snapshot(): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'pool-1',
    publicationEpoch: 'epoch',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      ...['left', 'right'].map((leafId) => ({
        type: 'terminal' as const,
        id: `terminal::${leafId}`,
        parentTabId: 'terminal',
        title: 'Shell',
        leafId,
        status: 'ready' as const,
        terminal: `pty-${leafId}`,
        isActive: false
      })),
      {
        type: 'agent-session',
        id: 'chat',
        title: 'Chat',
        sessionId: 'session',
        agent: 'codex',
        isActive: false
      }
    ]
  }
}

afterEach(() => vi.useRealTimers())

it('requests an explicit parent-tab close and accepts delegated retirement for final verification', async () => {
  const requests: unknown[] = []
  await closePersistentPoolTabs(
    {
      listMobileSessionTabs: async () => snapshot(),
      closeMobileSessionTab: async (...args) => {
        requests.push(args)
        return delegatedMobileSessionTabClose()
      }
    },
    'pool-1'
  )
  expect(requests).toEqual([
    ['id:pool-1', 'terminal', { force: false, reason: 'user' }],
    ['id:pool-1', 'chat', { force: false, reason: 'user' }]
  ])
})

it('keeps the slot active until delegated tabs and saved state actually retire', async () => {
  vi.useFakeTimers()
  let retired = false
  let available = false
  const verifyRetired = async () => {
    if (!retired) {
      throw new Error('Chat still published')
    }
  }
  const release = retirePersistentPoolTask({
    preflight: async () => {},
    retire: () => waitForPersistentPoolRetirement(verifyRetired),
    verifyRetired,
    commit: async () => {
      available = true
    }
  })
  await vi.advanceTimersByTimeAsync(200)
  expect(available).toBe(false)
  retired = true
  await vi.advanceTimersByTimeAsync(100)
  await release
  expect(available).toBe(true)
})

it('times out without freeing a slot whose tab never retires', async () => {
  vi.useFakeTimers()
  let available = false
  const verifyRetired = async () => {
    throw new Error('Chat still published')
  }
  const release = retirePersistentPoolTask({
    preflight: async () => {},
    retire: () => waitForPersistentPoolRetirement(verifyRetired),
    verifyRetired,
    commit: async () => {
      available = true
    }
  })
  const rejection = expect(release).rejects.toThrow('Chat still published')
  await vi.advanceTimersByTimeAsync(5_000)
  await rejection
  expect(available).toBe(false)
})

it('reports the blocked tab instead of accepting an explicit close refusal', async () => {
  await expect(
    closePersistentPoolTabs(
      {
        listMobileSessionTabs: async () => snapshot(),
        closeMobileSessionTab: async () => refusedMobileSessionTabClose('retirement-owner')
      },
      'pool-1'
    )
  ).rejects.toThrow('"Shell" (terminal): retirement-owner')
})
