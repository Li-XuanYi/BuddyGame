import type { MpdsDeterminant } from '../types'

export type DispatchTimingState = 'normal' | 'warning' | 'overtime'

export function getDispatchTimingState(elapsed: number): DispatchTimingState {
  if (elapsed > 60) return 'overtime'
  if (elapsed >= 45) return 'warning'
  return 'normal'
}

export function crossedDispatchWarning(previousElapsed: number, elapsed: number): boolean {
  return (previousElapsed < 45 && elapsed >= 45)
    || (previousElapsed <= 60 && elapsed > 60)
}

export function formatPlayerDeterminantCode(
  protocolNumber: number,
  determinant: MpdsDeterminant | null,
): string {
  return determinant ? `${protocolNumber}-${determinant[0]}-?` : `${protocolNumber}-?-?`
}
