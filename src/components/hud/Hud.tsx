// ============================================================
// 零点接线台 — HUD 状态栏
// ============================================================

import type { WorldState } from '../../game/types'
import type { ReactNode } from 'react'

interface Props {
  state: WorldState
  actions?: ReactNode
}

export function Hud({ state, actions }: Props) {
  const minutes = Math.floor(state.shiftElapsed / 60)
  const seconds = state.shiftElapsed % 60
  const timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`

  const callTime = state.currentCall
    ? state.shiftElapsed - state.callStartTime
    : 0
  const callTimeColor = callTime > 60 ? '#e74c3c' : callTime > 43 ? '#f39c12' : '#2ecc71'

  const isOnCall = state.currentCall !== null

  return (
    <div style={styles.container}>
      {/* 左侧：计时器 */}
      <div style={styles.group}>
        <span style={styles.icon}>⏱</span>
        <span style={styles.label}>班次</span>
        <span style={styles.value}>{timeStr}</span>
      </div>

      {/* 通话计时 */}
      {isOnCall && (
        <div style={styles.group}>
          <span style={styles.icon}>📞</span>
          <span style={styles.label}>通话</span>
          <span style={{ ...styles.value, color: callTimeColor }}>
            {String(Math.floor(callTime / 60)).padStart(2, '0')}:
            {String(callTime % 60).padStart(2, '0')}
          </span>
        </div>
      )}

      {/* 中间：通话编号 */}
      <div style={styles.group}>
        <span style={styles.icon}>📋</span>
        <span style={styles.label}>通话</span>
        <span style={styles.value}>
          {state.callIndex}/{state.totalCalls}
        </span>
      </div>

      {/* 右侧：累计得分 */}
      <div style={{ ...styles.group, marginLeft: 'auto' }}>
        <span style={styles.icon}>⭐</span>
        <span style={styles.label}>得分</span>
        <span style={{ ...styles.value, color: '#f1c40f' }}>{state.totalScore}</span>
      </div>

      {/* 救护车状态 */}
      {state.dispatchSent && state.ambulanceRemaining > 0 && (
        <div style={styles.group}>
          <span style={styles.icon}>🚑</span>
          <span style={{ ...styles.value, color: '#e74c3c', fontSize: 14 }}>
            ETA {state.ambulanceRemaining}s
          </span>
        </div>
      )}

      {state.dispatchSent && state.ambulanceRemaining === 0 && (
        <div style={styles.group}>
          <span style={styles.icon}>🚑</span>
          <span style={{ ...styles.value, color: '#2ecc71', fontSize: 14 }}>
            已到达
          </span>
        </div>
      )}

      {actions && <div style={styles.actions}>{actions}</div>}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '6px 16px',
    backgroundColor: '#0f172a',
    borderBottom: '1px solid #1e293b',
    flexShrink: 0,
    minHeight: 36,
    flexWrap: 'wrap' as const,
  },
  group: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  icon: {
    fontSize: 14,
  },
  label: {
    fontSize: 11,
    color: '#64748b',
    textTransform: 'uppercase' as const,
    fontWeight: 'bold',
  },
  value: {
    fontSize: 13,
    color: '#e2e8f0',
    fontWeight: 'bold',
    fontFamily: 'monospace',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
  },
}
