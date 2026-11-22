export type PersistentWorktreePoolSlot = {
  slot: number
  state: 'active' | 'available'
}

export function persistentWorktreePoolSize(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 16
    ? value
    : 0
}
