const EDITOR_OR_BUILD_COMMAND =
  /(?:^|[\\/\s"'])(?:UnrealEditor|UE4Editor|UnrealBuildTool|ShaderCompileWorker|UnrealHeaderTool|RunUAT|Build|MSBuild|devenv|Code|Rider|dotnet|cl|clang(?:\+\+)?|gcc|g\+\+|cmake|ninja|make)(?:\.exe|\.bat|\.cmd)?(?:[\s"']|$)/i

export function assertNoPersistentPoolProcess(
  worktreePath: string,
  processes: readonly { pid: number; command: string }[],
  platform: string
): void {
  const normalize = (value: string): string => {
    const slashes = value.replace(/\\/g, '/')
    return platform === 'win32' ? slashes.toLowerCase() : slashes
  }
  const path = normalize(worktreePath).replace(/\/$/, '')
  for (const process of processes) {
    if (!EDITOR_OR_BUILD_COMMAND.test(process.command)) {
      continue
    }
    const command = normalize(process.command)
    let offset = command.indexOf(path)
    while (offset !== -1) {
      const before = command[offset - 1]
      const after = command[offset + path.length]
      if ((!before || /[\s"'=]/.test(before)) && (!after || /[\s"'/]/.test(after))) {
        throw new Error(
          `Process ${process.pid} is using this pool path. Close it before returning the worktree.`
        )
      }
      offset = command.indexOf(path, offset + 1)
    }
  }
}

export async function retirePersistentPoolTask(ports: {
  preflight: () => Promise<void>
  retire: () => Promise<void>
  verifyRetired: () => Promise<void>
  commit: () => Promise<void>
}): Promise<void> {
  await ports.preflight()
  await ports.retire()
  await ports.verifyRetired()
  await ports.preflight()
  await ports.verifyRetired()
  await ports.commit()
}
