export function AudioControl({
  enabled,
  volume,
  onToggle,
  onVolume,
}: {
  enabled: boolean
  volume: number
  onToggle: () => void
  onVolume: (volume: number) => void
}) {
  return (
    <div style={controlStyles.wrapper} aria-label="游戏音效控制">
      <button
        type="button"
        style={controlStyles.button}
        onClick={onToggle}
        aria-pressed={enabled}
        aria-label={enabled ? '静音游戏音效' : '开启游戏音效'}
        title={enabled ? '静音' : '开启音效'}
      >
        {enabled ? '🔊' : '🔇'}
      </button>
      <input
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={volume}
        onChange={event => onVolume(Number(event.target.value))}
        aria-label="游戏音效音量"
        disabled={!enabled}
        style={controlStyles.slider}
      />
    </div>
  )
}

const controlStyles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: 0,
  },
  button: {
    width: 44,
    height: 44,
    border: '1px solid #475569',
    borderRadius: 6,
    color: '#e2e8f0',
    backgroundColor: '#0f172a',
    cursor: 'pointer',
    fontSize: 18,
  },
  slider: {
    width: 72,
    minHeight: 44,
    accentColor: '#38bdf8',
  },
}
