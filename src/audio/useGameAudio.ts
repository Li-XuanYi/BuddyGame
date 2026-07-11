import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type GameAudioCue =
  | 'connect'
  | 'question'
  | 'confirm'
  | 'warning'
  | 'dispatch'
  | 'arrival'
  | 'hangup'

const STORAGE_ENABLED = 'zero-hour-dispatch.audio-enabled'
const STORAGE_VOLUME = 'zero-hour-dispatch.audio-volume'

const CUE_PATTERNS: Record<GameAudioCue, Array<[frequency: number, delay: number, duration: number]>> = {
  connect: [[520, 0, 0.08], [720, 0.1, 0.12]],
  question: [[420, 0, 0.05]],
  confirm: [[660, 0, 0.06]],
  warning: [[880, 0, 0.1], [660, 0.14, 0.1], [880, 0.28, 0.12]],
  dispatch: [[440, 0, 0.08], [660, 0.1, 0.08], [880, 0.2, 0.16]],
  arrival: [[740, 0, 0.08], [980, 0.1, 0.18]],
  hangup: [[520, 0, 0.08], [320, 0.1, 0.16]],
}

class GameAudioEngine {
  private context: AudioContext | null = null

  play(cue: GameAudioCue, volume: number) {
    if (typeof window === 'undefined') return
    const AudioContextClass = window.AudioContext
    if (!AudioContextClass) return

    if (!this.context) this.context = new AudioContextClass()
    const context = this.context
    const schedule = () => {
      const start = context.currentTime
      for (const [frequency, delay, duration] of CUE_PATTERNS[cue]) {
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        oscillator.type = cue === 'warning' ? 'square' : 'sine'
        oscillator.frequency.setValueAtTime(frequency, start + delay)
        gain.gain.setValueAtTime(0.0001, start + delay)
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * 0.12), start + delay + 0.01)
        gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + duration)
        oscillator.connect(gain)
        gain.connect(context.destination)
        oscillator.start(start + delay)
        oscillator.stop(start + delay + duration + 0.02)
      }
    }

    if (context.state === 'suspended') {
      void context.resume().then(schedule).catch(() => undefined)
    } else {
      schedule()
    }
  }

  close() {
    if (this.context) void this.context.close()
    this.context = null
  }
}

export function useGameAudio() {
  const engineRef = useRef<GameAudioEngine | null>(null)
  if (!engineRef.current) engineRef.current = new GameAudioEngine()

  const [enabled, setEnabled] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.localStorage.getItem(STORAGE_ENABLED) !== 'false'
  })
  const [volume, setVolumeState] = useState(() => {
    if (typeof window === 'undefined') return 0.65
    const stored = Number(window.localStorage.getItem(STORAGE_VOLUME))
    return Number.isFinite(stored) && stored >= 0 && stored <= 1 ? stored : 0.65
  })

  useEffect(() => () => engineRef.current?.close(), [])

  const play = useCallback((cue: GameAudioCue) => {
    if (enabled) engineRef.current?.play(cue, volume)
  }, [enabled, volume])

  const toggle = useCallback(() => {
    setEnabled(current => {
      const next = !current
      window.localStorage.setItem(STORAGE_ENABLED, String(next))
      if (next) engineRef.current?.play('confirm', volume)
      return next
    })
  }, [volume])

  const setVolume = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(1, next))
    setVolumeState(clamped)
    window.localStorage.setItem(STORAGE_VOLUME, String(clamped))
  }, [])

  return useMemo(
    () => ({ enabled, volume, play, toggle, setVolume }),
    [enabled, play, setVolume, toggle, volume],
  )
}
