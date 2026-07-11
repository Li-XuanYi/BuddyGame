import { describe, expect, it } from 'vitest'
import {
  crossedDispatchWarning,
  formatPlayerDeterminantCode,
  getDispatchTimingState,
} from '../game/core/dispatchTiming'

describe('dispatch timing status', () => {
  it('warns at 45 seconds and only marks overtime after 60 seconds', () => {
    expect(getDispatchTimingState(44)).toBe('normal')
    expect(getDispatchTimingState(45)).toBe('warning')
    expect(getDispatchTimingState(60)).toBe('warning')
    expect(getDispatchTimingState(61)).toBe('overtime')
  })

  it('does not reveal the expected determinant before the player selects one', () => {
    expect(formatPlayerDeterminantCode(28, null)).toBe('28-?-?')
    expect(formatPlayerDeterminantCode(28, 'CHARLIE')).toBe('28-C-?')
  })

  it('detects warning thresholds even when an action skips over the exact second', () => {
    expect(crossedDispatchWarning(44, 47)).toBe(true)
    expect(crossedDispatchWarning(60, 63)).toBe(true)
    expect(crossedDispatchWarning(47, 60)).toBe(false)
  })
})
