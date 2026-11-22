import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { checkoutPersistentPoolBranch } from './persistent-pool-checkout'

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), 'orca-persistent-pool-'))
  const git = (args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'pool-test@example.invalid'])
  git(['config', 'user.name', 'Pool Test'])
  git(['config', 'core.autocrlf', 'false'])
  await writeFile(join(repo, '.gitignore'), 'Intermediate/\nBinaries/\n')
  await writeFile(join(repo, 'source.txt'), 'base\n')
  git(['add', '.'])
  git(['commit', '-m', 'Initial source'])
  return { repo, git, exec: async (args: string[]) => ({ stdout: git(args) }) }
}

it('changes task branches in place while preserving build outputs, untracked notes and old branches', async () => {
  const { repo, git, exec } = await fixture()
  await mkdir(join(repo, 'Intermediate'))
  await writeFile(join(repo, 'Intermediate', 'cached.obj'), 'compiled object')
  await writeFile(join(repo, 'notes.txt'), 'user notes')
  await checkoutPersistentPoolBranch({ branch: 'task-a', base: 'main', exec })
  await writeFile(join(repo, 'source.txt'), 'task a\n')
  git(['add', 'source.txt'])
  git(['commit', '-m', 'Task A'])
  await checkoutPersistentPoolBranch({ branch: 'task-b', base: 'main', exec })
  expect(git(['branch', '--show-current']).trim()).toBe('task-b')
  expect(git(['show', 'task-a:source.txt'])).toBe('task a\n')
  expect(await readFile(join(repo, 'source.txt'), 'utf8')).toBe('base\n')
  expect(await readFile(join(repo, 'Intermediate', 'cached.obj'), 'utf8')).toBe('compiled object')
  expect(await readFile(join(repo, 'notes.txt'), 'utf8')).toBe('user notes')
})

it('refuses tracked edits even when Git could carry them into the next task', async () => {
  const { repo, git, exec } = await fixture()
  await writeFile(join(repo, 'source.txt'), 'unsaved work\n')
  await expect(
    checkoutPersistentPoolBranch({ branch: 'next', base: 'main', exec })
  ).rejects.toThrow('uncommitted')
  expect(git(['branch', '--show-current']).trim()).toBe('main')
  expect(await readFile(join(repo, 'source.txt'), 'utf8')).toBe('unsaved work\n')
})

it('refuses to overwrite an ignored build output that becomes tracked on the requested branch', async () => {
  const { repo, git, exec } = await fixture()
  git(['checkout', '-b', 'tracks-build-output'])
  await mkdir(join(repo, 'Binaries'))
  await writeFile(join(repo, 'Binaries', 'app.dll'), 'tracked fixture')
  git(['add', '-f', 'Binaries/app.dll'])
  git(['commit', '-m', 'Track output on another branch'])
  git(['checkout', 'main'])
  await mkdir(join(repo, 'Binaries'), { recursive: true })
  await writeFile(join(repo, 'Binaries', 'app.dll'), 'user build')
  await expect(
    checkoutPersistentPoolBranch({ branch: 'next', base: 'tracks-build-output', exec })
  ).rejects.toThrow()
  expect(await readFile(join(repo, 'Binaries', 'app.dll'), 'utf8')).toBe('user build')
  expect(git(['branch', '--show-current']).trim()).toBe('main')
})
