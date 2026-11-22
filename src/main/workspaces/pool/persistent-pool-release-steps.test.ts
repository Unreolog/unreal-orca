import { describe, expect, it } from 'vitest'
import {
  assertNoPersistentPoolProcess,
  retirePersistentPoolTask
} from './persistent-pool-release-steps'

describe('persistent pool release safety', () => {
  it('refuses an external editor using the slot while accepting a different slot', () => {
    expect(() =>
      assertNoPersistentPoolProcess(
        'C:\\Work\\pool-1',
        [{ pid: 31, command: 'UnrealEditor.exe "C:\\Work\\pool-1\\Axogram.uproject"' }],
        'win32'
      )
    ).toThrow('31')
    expect(() =>
      assertNoPersistentPoolProcess(
        'C:\\Work\\pool-1',
        [{ pid: 32, command: 'UnrealEditor.exe C:\\Work\\pool-10\\Axogram.uproject' }],
        'win32'
      )
    ).not.toThrow()
  })

  it('matches Windows build paths case-insensitively without treating a native agent as an editor', () => {
    expect(() =>
      assertNoPersistentPoolProcess(
        'C:\\Work\\pool-1',
        [{ pid: 41, command: '"C:\\Tools\\MSBuild.exe" c:/work/POOL-1/Project.sln' }],
        'win32'
      )
    ).toThrow('41')
    expect(() =>
      assertNoPersistentPoolProcess(
        'C:\\Work\\pool-1',
        [{ pid: 42, command: 'codex.exe --cwd C:\\Work\\pool-1' }],
        'win32'
      )
    ).not.toThrow()
  })

  it('never makes a slot available if presentation retirement cannot be proven', async () => {
    let available = false
    await expect(
      retirePersistentPoolTask({
        preflight: async () => {},
        retire: async () => {},
        verifyRetired: async () => {
          throw new Error('chat tab remains')
        },
        commit: async () => {
          available = true
        }
      })
    ).rejects.toThrow('chat tab remains')
    expect(available).toBe(false)
  })

  it('checks the checkout and processes again after teardown before releasing', async () => {
    const events: string[] = []
    let preflights = 0
    await expect(
      retirePersistentPoolTask({
        preflight: async () => {
          events.push('check')
          preflights += 1
          if (preflights === 2) {
            throw new Error('build started')
          }
        },
        retire: async () => {
          events.push('retire')
        },
        verifyRetired: async () => {
          events.push('verify')
        },
        commit: async () => {
          events.push('available')
        }
      })
    ).rejects.toThrow('build started')
    expect(events).toEqual(['check', 'retire', 'verify', 'check'])
  })

  it('commits only after both preflight and retirement proofs pass', async () => {
    const events: string[] = []
    await retirePersistentPoolTask({
      preflight: async () => {
        events.push('check')
      },
      retire: async () => {
        events.push('retire')
      },
      verifyRetired: async () => {
        events.push('verify')
      },
      commit: async () => {
        events.push('available')
      }
    })
    expect(events).toEqual(['check', 'retire', 'verify', 'check', 'verify', 'available'])
  })
})
