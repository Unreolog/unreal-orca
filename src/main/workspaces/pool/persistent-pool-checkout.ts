export type PersistentPoolGit = (args: string[]) => Promise<{ stdout: string }>

export async function assertPersistentPoolCheckoutClean(exec: PersistentPoolGit): Promise<void> {
  const status = await exec(['status', '--porcelain=v1', '-z', '--untracked-files=no'])
  if (status.stdout.length > 0) {
    throw new Error('This pool worktree has uncommitted tracked changes. Commit them before reuse.')
  }
}

export async function checkoutPersistentPoolBranch(args: {
  branch: string
  base: string
  checkoutExistingBranch?: boolean
  exec: PersistentPoolGit
}): Promise<void> {
  await assertPersistentPoolCheckoutClean(args.exec)
  // Git normally overwrites ignored files on checkout; build outputs must survive task changes.
  await args.exec([
    'checkout',
    '--no-overwrite-ignore',
    ...(args.checkoutExistingBranch ? [args.branch] : ['--no-track', '-b', args.branch, args.base])
  ])
}
