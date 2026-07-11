// ============================================================
// 零点接线台 — 调度主界面（双线程：电话+终端）
// ============================================================

import { useReducer, useEffect, useRef, useCallback, useState } from 'react'
import type { TriageLevel, MpdsDeterminant, CallPhase, TerminalState, CalleeStressLevel } from '../game/types'
import { MPDS_DETERMINANT_INFO, STRESS_INFO } from '../game/types'
import type { TerminalField } from '../game/core/actions'
import { worldReducer } from '../game/core/worldReducer'
import { createInitialState } from '../game/core/initialState'
import { getCaller } from '../game/npc/personas'
import { detectEnding } from '../game/endings/endings'
import { Hud } from '../components/hud/Hud'
import { AudioControl } from '../audio/AudioControl'
import { useGameAudio } from '../audio/useGameAudio'
import {
  crossedDispatchWarning,
  formatPlayerDeterminantCode,
  getDispatchTimingState,
} from '../game/core/dispatchTiming'
import type { EndingDef } from '../game/types'

interface Props {
  onNavigate: (screen: 'title' | 'ending', ending?: EndingDef, totalScore?: number) => void
}

const TRIAGE_OPTIONS: { level: TriageLevel; label: string; color: string; desc: string }[] = [
  { level: 'red', label: '红色', color: '#e74c3c', desc: '濒危——即刻派车' },
  { level: 'yellow', label: '黄色', color: '#f39c12', desc: '危重——优先派车' },
  { level: 'green', label: '绿色', color: '#27ae60', desc: '轻伤——常规派车' },
  { level: 'black', label: '黑色', color: '#7f8c8d', desc: '死亡/无需抢救' },
]

export function GameScreen({ onNavigate }: Props) {
  const [state, dispatch] = useReducer(worldReducer, null, createInitialState)
  const [terminalModalOpen, setTerminalModalOpen] = useState(false)
  const audio = useGameAudio()
  const previousAmbulanceRemaining = useRef(state.ambulanceRemaining)
  const previousCallElapsed = useRef(0)
  const previousCallId = useRef<string | null>(null)

  // --- 初始化班次 ---
  useEffect(() => {
    dispatch({ type: 'START_SHIFT' })
  }, [])

  // --- 新通话时强制关闭调度卡 ---
  useEffect(() => {
    if (!state.currentCall) setTerminalModalOpen(false)
  }, [state.currentCall])

  // --- 计时器 ---
  useEffect(() => {
    if (state.screen !== 'playing') return
    const id = setInterval(() => dispatch({ type: 'TICK' }), 1000)
    return () => clearInterval(id)
  }, [state.screen])

  useEffect(() => {
    const elapsed = state.shiftElapsed - state.callStartTime
    const callId = state.currentCall?.id ?? null
    if (!callId) {
      previousCallElapsed.current = 0
      previousCallId.current = null
      return
    }

    if (previousCallId.current !== callId) {
      previousCallElapsed.current = 0
      previousCallId.current = callId
    }

    if (crossedDispatchWarning(previousCallElapsed.current, elapsed)) audio.play('warning')
    previousCallElapsed.current = elapsed
  }, [audio, state.callStartTime, state.currentCall, state.shiftElapsed])

  useEffect(() => {
    const previous = previousAmbulanceRemaining.current
    if (previous > 0 && state.ambulanceRemaining === 0) audio.play('arrival')
    previousAmbulanceRemaining.current = state.ambulanceRemaining
  }, [audio, state.ambulanceRemaining])

  // --- 检测结局 ---
  useEffect(() => {
    if (state.screen === 'ending') {
      const ending = detectEnding(state.totalScore)
      onNavigate('ending', ending, state.totalScore)
    }
  }, [onNavigate, state.screen, state.totalScore])

  // --- 自动滚动对话 ---
  const dialogueRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (dialogueRef.current) {
      dialogueRef.current.scrollTop = dialogueRef.current.scrollHeight
    }
  }, [state.dialogueLog.length])

  // --- 流式逐字显示：多行排队依次输出 ---
  const prevLogLen = useRef(0)                         // 上一次已处理的对话行数
  const pendingSet = useRef(new Set<number>())          // 已入队、尚未流式完毕的行索引
  const pendingQueue = useRef<{ idx: number; text: string }[]>([])  // 待流式的行队列
  const timerId = useRef<number | null>(null)           // 定时器
  const queueTimeoutId = useRef<number | null>(null)    // 行间延迟定时器
  const isProcessing = useRef(false)                    // 是否正在处理队列
  const streamingCallId = useRef<string | null>(null)
  const [streamIdx, setStreamIdx] = useState(-1)        // 正在流式的行
  const [streamPos, setStreamPos] = useState(0)         // 已显示字符数

  // 启动队列处理（幂等：已在处理中则跳过）
  const startQueue = useCallback(() => {
    if (isProcessing.current) return
    if (pendingQueue.current.length === 0) {
      setStreamIdx(-1)
      return
    }

    isProcessing.current = true
    const item = pendingQueue.current.shift()!
    pendingSet.current.delete(item.idx)   // 开始流式，移出待流式集合
    const chars = [...item.text]
    setStreamIdx(item.idx)
    setStreamPos(0)

    let pos = 0
    timerId.current = window.setInterval(() => {
      pos += 1
      if (pos >= chars.length) {
        setStreamPos(chars.length)
        if (timerId.current !== null) {
          clearInterval(timerId.current)
          timerId.current = null
        }
        isProcessing.current = false
        // 行间短暂停顿后开始下一行
        queueTimeoutId.current = window.setTimeout(() => {
          queueTimeoutId.current = null
          startQueue()
        }, 50)
      } else {
        setStreamPos(pos)
      }
    }, 28)  // ~35 字符/秒
  }, [])

  const clearStreamingWork = useCallback(() => {
    if (timerId.current !== null) window.clearInterval(timerId.current)
    if (queueTimeoutId.current !== null) window.clearTimeout(queueTimeoutId.current)
    timerId.current = null
    queueTimeoutId.current = null
    pendingQueue.current = []
    pendingSet.current.clear()
    prevLogLen.current = 0
    isProcessing.current = false
  }, [])

  useEffect(() => {
    const callId = state.currentCall?.id ?? null
    if (streamingCallId.current === callId) return
    clearStreamingWork()
    streamingCallId.current = callId
    setStreamIdx(-1)
    setStreamPos(0)
  }, [clearStreamingWork, state.currentCall?.id])

  // 新对话行入队
  useEffect(() => {
    if (!state.currentCall) {
      prevLogLen.current = state.dialogueLog.length
      return
    }

    const curLen = state.dialogueLog.length
    const oldLen = prevLogLen.current
    prevLogLen.current = curLen

    if (curLen <= oldLen) return

    for (let i = oldLen; i < curLen; i++) {
      pendingQueue.current.push({ idx: i, text: state.dialogueLog[i].text })
      pendingSet.current.add(i)          // 标记为待流式
    }

    startQueue()
  }, [state.currentCall, state.dialogueLog, startQueue])

  // --- 安抚来电者 ---
  const handleCalm = useCallback(() => {
    audio.play('confirm')
    dispatch({ type: 'CALM_CALLER' })
  }, [audio])

  // --- 打开调度卡 ---
  const handleOpenTerminal = useCallback(() => {
    audio.play('confirm')
    setTerminalModalOpen(true)
  }, [audio])

  const handleCloseTerminal = useCallback(() => {
    setTerminalModalOpen(false)
  }, [])

  useEffect(() => () => clearStreamingWork(), [clearStreamingWork])

  // --- 处理派车（从模态框调用）---
  const handleDispatch = useCallback(() => {
    if (!state.currentCall) return
    if (!state.terminal.triage || !state.terminal.determinant) return
    audio.play('dispatch')
    setTerminalModalOpen(false)
    dispatch({ type: 'DISPATCH' })
  }, [audio, state.currentCall, state.terminal.determinant, state.terminal.triage])

  // --- 处理临床判断选择 ---
  const handleJudgment = useCallback((judgmentId: string, optionIndex: number) => {
    audio.play('confirm')
    dispatch({ type: 'MAKE_JUDGMENT', judgmentId, chosenOptionIndex: optionIndex })
  }, [audio])

  const handleAnswer = useCallback(() => {
    audio.play('connect')
    dispatch({ type: 'ANSWER_CALL' })
  }, [audio])

  const handleAsk = useCallback((questionId: string) => {
    audio.play('question')
    dispatch({ type: 'ASK_QUESTION', questionId })
  }, [audio])

  const handleGuidanceAnswer = useCallback((stepIndex: number, selectedIndex: number) => {
    audio.play('confirm')
    dispatch({ type: 'ANSWER_GUIDANCE', stepIndex, selectedIndex })
  }, [audio])

  const handleEndCall = useCallback(() => {
    audio.play('hangup')
    dispatch({ type: 'END_CALL' })
  }, [audio])

  const audioControl = (
    <AudioControl
      enabled={audio.enabled}
      volume={audio.volume}
      onToggle={audio.toggle}
      onVolume={audio.setVolume}
    />
  )

  // 无活跃通话时 — 准备接听
  if (!state.currentCall && state.callIndex < state.totalCalls) {
    return (
      <div style={styles.container}>
        <Hud state={state} actions={audioControl} />
        <CallWaiting
          callIndex={state.callIndex}
          totalCalls={state.totalCalls}
          onAnswer={handleAnswer}
          shiftElapsed={state.shiftElapsed}
          totalScore={state.totalScore}
          lastScore={state.callScores[state.callScores.length - 1]}
        />
      </div>
    )
  }

  // 无更多通话
  if (!state.currentCall && state.callIndex >= state.totalCalls) {
    return (
      <div style={styles.container}>
        <Hud state={state} actions={audioControl} />
        <div style={styles.centerMessage}>
          <h2 style={{ color: '#e2e8f0' }}>本班次所有通话已处理完毕</h2>
          <p style={{ color: '#94a3b8' }}>正在生成班次评估报告...</p>
        </div>
      </div>
    )
  }

  // --- 通话中 ---
  const call = state.currentCall!
  const caller = getCaller(call.callerId)
  const hasDispatchDecision = state.terminal.triage !== null && state.terminal.determinant !== null

  return (
    <div style={styles.container}>
      <Hud state={state} actions={audioControl} />

      {/* ====== 电话面板（全宽） ====== */}
      <div style={styles.phonePanel}>
        <PhoneHeader
          phoneNumber={call.phoneNumber}
          baseStation={call.baseStation}
          callerName={caller.name}
          relationship={caller.relationship}
          callPhase={state.callPhase}
          elapsed={state.shiftElapsed - state.callStartTime}
          stressLevel={state.callerState?.stressLevel ?? 'anxious'}
          stress={state.callerState?.stress ?? 50}
          questionCost={state.questionCost}
        />

        {/* 对话区 — 每条来电者发言旁可能弹出临床判断卡 */}
        <div ref={dialogueRef} style={styles.dialogueArea}>
          {state.dialogueLog.map((line, i) => {
            const isStreaming = i === streamIdx
            const isPending = pendingSet.current.has(i) && !isStreaming
            const displayText = isStreaming
              ? [...line.text].slice(0, streamPos).join('')
              : isPending
                ? ''
                : line.text
            const showCursor = isStreaming && streamPos < [...line.text].length
            // 该行已流式完成（不在待流式集合，且不是当前正在流式的行）
            const hasFinished = !isStreaming && !pendingSet.current.has(i) && displayText.length > 0
            // 查找附着在该行上的判断卡
            const judgment = state.pendingJudgments?.find(
              j => j.dialogueIndex === i && line.speaker === 'caller'
            )
            return (
              <div key={i}>
                <TranscriptLine
                  line={line}
                  index={i}
                  displayText={displayText}
                  showCursor={showCursor}
                />
                {/* 来电者行流式完成后，若有判断卡则显示 */}
                {judgment && hasFinished && (
                  <JudgmentCard
                    judgment={judgment}
                    onSelect={(optIdx) => handleJudgment(judgment.id, optIdx)}
                  />
                )}
              </div>
            )
          })}
        </div>

        {/* 急救指导面板 */}
        {state.callPhase === 'guidance' && call.guidance && (
          <GuidancePanel
            guidance={call.guidance}
            stepIndex={state.guidanceStepIndex}
            results={state.guidanceResults}
            onAnswer={handleGuidanceAnswer}
          />
        )}

        {/* 问询按钮区 */}
        {(state.callPhase === 'questioning' || state.callPhase === 'connected') && (
          <QuestionPanel
            call={call}
            askedMPDS={state.callerState?.askedMPDS ?? []}
            stressLevel={state.callerState?.stressLevel ?? 'anxious'}
            stress={state.callerState?.stress ?? 50}
            questionCost={state.questionCost}
            onAsk={handleAsk}
            onCalm={handleCalm}
            onOpenTerminal={handleOpenTerminal}
            hasTriage={hasDispatchDecision}
            responseMode={state.terminal.hotCold}
          />
        )}

        {/* 收尾阶段 */}
        {state.callPhase === 'closing' && (
          <div style={styles.closingPanel}>
            <p style={{ color: '#4ade80', fontWeight: 'bold', marginBottom: 8 }}>
              {call.guidance ? '急救指导已完成，等待救护车到达。' : '派车指令已发出。'}
            </p>
            <button style={styles.endCallBtn} onClick={handleEndCall}>
              挂断电话
            </button>
          </div>
        )}
      </div>

      {/* ====== MPDS调度卡弹出模态框 ====== */}
      {terminalModalOpen && (
        <TerminalModal
          mpdsCard={call.mpdsCard}
          terminal={state.terminal}
          dispatchSent={state.dispatchSent}
          ambulanceRemaining={state.ambulanceRemaining}
          canDispatch={state.callPhase === 'questioning' || state.callPhase === 'connected'}
          onChange={(field, value) =>
            dispatch({ type: 'UPDATE_TERMINAL', field, value })
          }
          onSetStatus={(field, value) => {
            audio.play('confirm')
            dispatch({ type: 'SET_PATIENT_STATUS', field, value })
          }}
          onSetDeterminant={(d) => {
            audio.play('confirm')
            dispatch({ type: 'SET_MPDS_DETERMINANT', determinant: d })
          }}
          onTriage={(level) => {
            audio.play('confirm')
            dispatch({ type: 'SET_TRIAGE', level })
          }}
          onDispatch={handleDispatch}
          onClose={handleCloseTerminal}
          onEndCall={() => { setTerminalModalOpen(false); handleEndCall() }}
        />
      )}
    </div>
  )
}

// ============================================================
// 子组件
// ============================================================

/** 等待接听界面 */
function CallWaiting({
  callIndex,
  totalCalls,
  onAnswer,
  shiftElapsed,
  totalScore,
  lastScore,
}: {
  callIndex: number
  totalCalls: number
  onAnswer: () => void
  shiftElapsed: number
  totalScore: number
  lastScore?: number
}) {
  return (
    <div style={styles.centerMessage}>
      <div style={{
        fontSize: 64,
        marginBottom: 8,
        animation: 'pulse-live 0.8s ease-in-out infinite',
      }}>
        📞
      </div>
      <h2 style={{ color: '#e2e8f0', margin: '0 0 4px', fontSize: 18 }}>
        第 {callIndex + 1}/{totalCalls} 通来电
      </h2>
      <p style={{ color: '#f87171', fontWeight: 'bold', margin: '0 0 8px', fontSize: 13 }}>
        线路接通中...
      </p>
      {lastScore !== undefined && (
        <p style={{ color: '#4ade80', fontWeight: 'bold', margin: '0 0 12px' }}>
          上一通得分：{lastScore}/100
        </p>
      )}
      <p style={{ color: '#64748b', marginBottom: 16, fontSize: 12 }}>
        班次运行 {Math.floor(shiftElapsed / 60)}分{shiftElapsed % 60}秒 | 累计 {totalScore}分
      </p>
      <button style={styles.answerBtn} onClick={onAnswer}>
        接 听 电 话
      </button>
    </div>
  )
}

/** 电话面板顶部 — 紧急调度台风格 + 来电者压力指示器 */
function PhoneHeader({
  phoneNumber,
  baseStation,
  callerName,
  relationship,
  callPhase,
  elapsed,
  stressLevel,
  stress,
  questionCost,
}: {
  phoneNumber: string
  baseStation: string
  callerName: string
  relationship: string
  callPhase: CallPhase
  elapsed: number
  stressLevel: CalleeStressLevel
  stress: number
  questionCost: number
}) {
  const mm = Math.floor(elapsed / 60)
  const ss = elapsed % 60
  const timingState = getDispatchTimingState(elapsed)
  const urgent = timingState !== 'normal'
  const overdue = timingState === 'overtime'
  const si = STRESS_INFO[stressLevel]

  return (
    <div style={styles.phoneHeader}>
      {/* 第一行：LIVE指示器 + 通话计时 */}
      <div style={styles.callLiveBar}>
        <span style={styles.liveDot}>●</span>
        <span style={styles.liveLabel}>LIVE</span>
        <span style={{
          ...styles.callTimer,
          color: urgent ? '#f87171' : '#facc15',
          fontWeight: urgent ? 900 : 700,
        }}>
          通话 {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
        </span>
        <span style={{
          ...styles.targetBadge,
          color: urgent ? '#f87171' : '#facc15',
          borderColor: urgent ? '#f87171' : '#facc15',
        }}>
          {overdue ? '⚠ 超时' : urgent ? '⚠ 即将超时' : '目标 60秒派车'}
        </span>
      </div>

      {/* 第二行：来电信息 + 问询耗时 */}
      <div style={styles.phoneHeaderInfo}>
        <span>{phoneNumber}</span>
        <span style={{ color: '#64748b' }}>|</span>
        <span>基站 {baseStation}</span>
        <span style={{ color: '#64748b' }}>|</span>
        <span>{callerName}（{relationship}）</span>
        <span style={{ marginLeft: 'auto', color: '#fbbf24', fontSize: 11, fontFamily: 'monospace' }}>
          问询耗时 {questionCost}s
        </span>
      </div>

      {/* 第三行：来电者压力指示器 */}
      <div style={styles.stressBar}>
        <span style={{ fontSize: 11, color: '#94a3b8', minWidth: 40 }}>
          {si.emoji} {si.label}
        </span>
        <div style={styles.stressTrack}>
          <div style={{
            ...styles.stressFill,
            width: `${stress}%`,
            backgroundColor: si.color,
          }} />
        </div>
        <span style={{ fontSize: 10, color: si.color, minWidth: 28, textAlign: 'right', fontFamily: 'monospace' }}>
          {stress}%
        </span>
      </div>

      {/* 第四行：阶段指示 */}
      <div style={styles.callPhaseTag}>
        {callPhase === 'questioning' && '问询中'}
        {callPhase === 'guidance' && '急救指导'}
        {callPhase === 'closing' && '收尾'}
        {callPhase === 'connected' && '已接通'}
        {stressLevel === 'hysterical' && <span style={{ color: '#ef4444', marginLeft: 8 }}>⚠ 来电者情绪失控！</span>}
      </div>
    </div>
  )
}

/** 通话逐字稿 — 单列时序记录，支持流式逐字输出 */
function TranscriptLine({
  line,
  index,
  displayText,
  showCursor,
}: {
  line: { speaker: string; text: string }
  index: number
  displayText?: string
  showCursor?: boolean
}) {
  const isCaller = line.speaker === 'caller'
  const isOperator = line.speaker === 'operator'
  const speakerLabel = isCaller ? '来电者' : isOperator ? '接线员' : '系统'
  const text = displayText ?? line.text

  return (
    <div style={{
      ...styles.transcript,
      animation: `fade-in-up 0.3s ease-out both`,
      animationDelay: `${index * 0.02}s`,
    }}>
      <span style={{
        ...styles.transcriptSpeaker,
        color: isCaller ? '#f87171' : isOperator ? '#60a5fa' : '#94a3b8',
      }}>
        [{speakerLabel}]
      </span>
      <span style={{
        ...styles.transcriptText,
        color: isCaller ? '#fecaca' : '#e2e8f0',
        fontStyle: isCaller ? 'italic' : 'normal',
      }}>
        {text}
        {showCursor && (
          <span style={styles.streamCursor}>▌</span>
        )}
      </span>
    </div>
  )
}

/** 临床判断卡 — 来电者叙述完后，玩家从中做出专业推理 */
function JudgmentCard({
  judgment,
  onSelect,
}: {
  judgment: import('../game/types').JudgmentPrompt
  onSelect: (optionIndex: number) => void
}) {
  const isResolved = judgment.chosenOptionIndex !== null

  return (
    <div style={{
      ...styles.judgmentCard,
      borderColor: isResolved ? '#475569' : '#fbbf24',
    }}>
      <div style={styles.judgmentHeader}>
        <span style={styles.judgmentIcon}>🔍</span>
        <span style={styles.judgmentQuestion}>{judgment.question}</span>
        {isResolved && (
          <span style={{
            color: judgment.options[judgment.chosenOptionIndex!].isCorrect ? '#4ade80' : '#f87171',
            fontSize: 10,
            fontWeight: 'bold',
            marginLeft: 'auto',
          }}>
            {judgment.options[judgment.chosenOptionIndex!].isCorrect ? '✅ 正确' : '❌ 需复核'}
          </span>
        )}
      </div>
      <div style={styles.judgmentOptions}>
        {judgment.options.map((opt, idx) => {
          const isChosen = judgment.chosenOptionIndex === idx
          const isCorrectReveal = isResolved && opt.isCorrect
          let bgColor = '#0f172a'
          let borderColor = '#334155'
          if (isResolved) {
            if (isChosen) {
              bgColor = opt.isCorrect ? '#0a2e0a' : '#2e0a0a'
              borderColor = opt.isCorrect ? '#27ae60' : '#ef4444'
            } else if (isCorrectReveal) {
              bgColor = '#0a2e0a'
              borderColor = '#27ae60'
            }
          }

          return (
            <button
              key={idx}
              style={{
                ...styles.judgmentOption,
                backgroundColor: bgColor,
                borderColor,
                cursor: isResolved ? 'default' : 'pointer',
                opacity: isResolved && !isChosen && !isCorrectReveal ? 0.4 : 1,
              }}
              onClick={() => !isResolved && onSelect(idx)}
              disabled={isResolved}
            >
              <span style={styles.judgmentOptionMarker}>
                {String.fromCharCode(65 + idx)}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontWeight: isChosen ? 'bold' : 'normal',
                  color: isChosen
                    ? (opt.isCorrect && isResolved ? '#4ade80' : isResolved ? '#f87171' : '#fbbf24')
                    : '#e2e8f0',
                }}>
                  {opt.label}
                </div>
                {opt.sublabel && (
                  <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>
                    {opt.sublabel}
                  </div>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 字段映射：reveals → 终端字段，用于标注按钮会回填什么 */
const REVEALS_HINT: Record<string, string> = {
  consciousness: '意识',
  breathing: '呼吸',
  age: '年龄',
  gender: '性别',
  chiefComplaint: '主诉',
  additional: '备注',
}

/** 问题层级配色 */
const TIER_STYLE: Record<string, { border: string; bg: string; badge: string; label: string }> = {
  critical:  { border: '#ef4444', bg: '#1a0a0a', badge: '#ef4444', label: '🔴 关键' },
  important: { border: '#f59e0b', bg: '#1a1408', badge: '#f59e0b', label: '🟡 重要' },
  detail:    { border: '#22c55e', bg: '#0a1a0a', badge: '#22c55e', label: '🟢 细节' },
}

/** 问询按钮面板 — 5步标准协议 + 补充MPDS问询 */
function QuestionPanel({
  call,
  askedMPDS,
  stressLevel,
  stress,
  questionCost,
  onAsk,
  onCalm,
  onOpenTerminal,
  hasTriage,
  responseMode,
}: {
  call: import('../game/types').EmergencyScenario
  askedMPDS: string[]
  stressLevel: CalleeStressLevel
  stress: number
  questionCost: number
  onAsk: (id: string) => void
  onCalm: () => void
  onOpenTerminal: () => void
  hasTriage: boolean
  responseMode: TerminalState['hotCold']
}) {
  const isAsked = (id: string) => askedMPDS.includes(id)
  const si = STRESS_INFO[stressLevel]

  // --- 5步协议状态 ---
  const step1Done = isAsked('step1_location')
  const step2Done = isAsked('step2_event')
  const step3Done = isAsked('step3_count')
  const step4Done = isAsked('step4_age')
  const step5Done = isAsked('step5_vitals')
  const landmarkDone = isAsked('ask_landmark')
  const contactDone = isAsked('ask_contact')
  const purposeDone = isAsked('ask_purpose')

  const allFiveStepsDone = step1Done && step2Done && step3Done && step4Done && step5Done

  // 下一步：第一个未完成的步骤
  const nextStepLabel =
    !step1Done ? 1 : !step2Done ? 2 : !step3Done ? 3 : !step4Done ? 4 : !step5Done ? 5 : null

  // 补充MPDS问题（5步完成后方可问询）
  const supplementaryQ = call.mpdsQuestions  // 所有MPDS问题现在都是补充性质

  // 5步协议定义
  const protocolSteps = [
    { step: 1, id: 'step1_location', icon: '📍', label: '位置确认', qText: '请问事发的确切地址是哪里？', timeCost: 2, desc: '派车根本依据' },
    { step: 2, id: 'step2_event', icon: '📋', label: '事件简述', qText: '好的，请告诉我具体发生了什么事？', timeCost: 3, desc: '获取主诉入口' },
    { step: 3, id: 'step3_count', icon: '👥', label: '患者人数', qText: '一共有几个人受伤/不适？', timeCost: 2, desc: '评估事件规模' },
    { step: 4, id: 'step4_age', icon: '👤', label: '患者年龄', qText: '患者多大年龄了？', timeCost: 2, desc: '关键救治因素' },
    { step: 5, id: 'step5_vitals', icon: '💓', label: '意识与呼吸', qText: '患者清醒吗？他/她还有呼吸吗？', timeCost: 3, desc: '最关键的病情评估' },
  ]

  return (
    <div style={styles.questionArea}>
      {/* ====== 协议卡参考 (折叠式) ====== */}
      <details style={styles.qRefCard} open={false}>
        <summary style={styles.qRefHeader}>
          <span style={styles.qRefProto}>协议 {call.mpdsCard.number} 参考</span>
          <span style={{
            ...styles.qRefBadge,
            backgroundColor: responseMode === 'HOT'
              ? '#c0392b'
              : responseMode === 'COLD'
                ? '#2e86c1'
                : '#475569',
          }}>
            {responseMode ?? '待判定'}
          </span>
        </summary>
        <div style={styles.qRefList}>
          {call.mpdsCard.keyQuestions.map((kq, i) => (
            <div key={i} style={styles.qRefItem}>
              <span style={styles.qRefDot}>•</span>
              {kq}
            </div>
          ))}
        </div>
      </details>

      {/* ====== 5步标准协议 ====== */}
      <div style={styles.qSection}>
        <div style={styles.qSectionTitle}>
          📡 标准协议（Protocol 0）
          {allFiveStepsDone && <span style={{ color: '#4ade80', marginLeft: 6 }}>✓ 全部完成</span>}
        </div>

        <div style={styles.protocolStepsList}>
          {protocolSteps.map((ps) => {
            const done = isAsked(ps.id)
            const isCurrent = ps.step === nextStepLabel
            const locked = !done && !isCurrent

            return (
              <div key={ps.id} style={{
                ...styles.protocolStepRow,
                opacity: locked ? 0.45 : 1,
                borderColor: done ? '#27ae60' : isCurrent ? '#fbbf24' : '#1e293b',
                backgroundColor: done ? 'rgba(34,197,94,0.06)' : isCurrent ? 'rgba(251,191,36,0.06)' : 'transparent',
              }}>
                {/* 步骤编号 */}
                <div style={{
                  ...styles.protocolStepNum,
                  backgroundColor: done ? '#27ae60' : isCurrent ? '#fbbf24' : '#1e293b',
                  color: done ? '#fff' : isCurrent ? '#000' : '#475569',
                }}>
                  {done ? '✓' : ps.step}
                </div>

                {/* 步骤信息 */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 12,
                    fontWeight: done ? 'normal' : 'bold',
                    color: done ? '#4ade80' : isCurrent ? '#fbbf24' : '#94a3b8',
                    textDecoration: done ? 'line-through' : 'none',
                  }}>
                    {ps.icon} {ps.label}
                  </div>
                  <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>
                    {ps.qText}
                  </div>
                </div>

                {/* 操作按钮 */}
                {done ? (
                  <span style={{ fontSize: 12, color: '#4ade80', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                    ✓ 完成
                  </span>
                ) : isCurrent ? (
                  <button
                    style={styles.protocolStepBtn}
                    onClick={() => onAsk(ps.id)}
                  >
                    询问 ({ps.timeCost}s)
                  </button>
                ) : (
                  <span style={{ fontSize: 10, color: '#475569', whiteSpace: 'nowrap' }}>
                    🔒 等待
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* ====== 补充信息（5步完成后方出现） ====== */}
      {allFiveStepsDone && (
        <div style={styles.qSection}>
          <div style={styles.qSectionTitle}>📎 补充信息（按需问询）</div>
          <div style={styles.qGrid}>
            {/* 标志建筑 */}
            {!landmarkDone && (
              <AskBtnEx
                id="ask_landmark"
                label="标志建筑"
                icon="🏢"
                hintTerm="精确地址"
                timeCost={2}
                done={false}
                tier="important"
                onClick={() => onAsk('ask_landmark')}
              />
            )}
            {landmarkDone && (
              <div style={{ ...styles.qBtnSmall, borderColor: '#27ae60', color: '#4ade80', backgroundColor: '#1a3a1a' }}>
                ✓ 地址已精确
              </div>
            )}

            {/* 联系电话 */}
            {!contactDone && (
              <AskBtnEx
                id="ask_contact"
                label="联系电话"
                icon="📞"
                timeCost={1}
                done={false}
                tier="detail"
                onClick={() => onAsk('ask_contact')}
              />
            )}
            {contactDone && (
              <div style={{ ...styles.qBtnSmall, borderColor: '#27ae60', color: '#4ade80', backgroundColor: '#1a3a1a' }}>
                ✓ 已记录
              </div>
            )}

            {!purposeDone && (
              <AskBtnEx
                id="ask_purpose"
                label="求助诉求"
                icon="🆘"
                hintTerm="诉求"
                timeCost={1}
                done={false}
                tier="important"
                onClick={() => onAsk('ask_purpose')}
              />
            )}
            {purposeDone && (
              <div style={{ ...styles.qBtnSmall, borderColor: '#27ae60', color: '#4ade80', backgroundColor: '#1a3a1a' }}>
                ✓ 诉求已确认
              </div>
            )}

            {/* 场景专属补充MPDS问题 */}
            {supplementaryQ.map((q) => (
              <AskBtnEx
                key={q.id}
                id={q.id}
                label={q.label}
                icon={CATEGORY_ICON[q.category] || '📋'}
                hintTerm={q.reveals.map(f => REVEALS_HINT[f] || '').filter(Boolean).join('·') || undefined}
                timeCost={q.timeCost}
                done={isAsked(q.id)}
                disabled={isAsked(q.id)}
                tier={q.tier}
                onClick={() => onAsk(q.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* ====== 安抚按钮 + 调度卡入口 + 压力提示 ====== */}
      <div style={styles.bottomToolbar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 11, color: si.color, display: 'flex', alignItems: 'center', gap: 4 }}>
            {si.emoji} {si.label} ({stress}%)
            {(stressLevel === 'panicked' || stressLevel === 'hysterical') && (
              <span style={{ color: '#fbbf24', fontSize: 10 }}>⚠ 答案不准确</span>
            )}
          </div>
          <button
            style={{
              ...styles.calmBtn,
              opacity: stress < 15 ? 0.4 : 1,
              cursor: stress < 15 ? 'not-allowed' : 'pointer',
            }}
            onClick={stress >= 15 ? onCalm : undefined}
            disabled={stress < 15}
            title="消耗2秒安抚来电者"
          >
            🫂 安抚 (+2s耗时)
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace' }}>
            耗时 {questionCost}s
          </span>
          <button
            style={{
              ...styles.terminalBtn,
              animation: !hasTriage ? 'pulse-alert 1.5s ease-in-out infinite' : 'none',
              borderColor: hasTriage ? '#27ae60' : '#ef4444',
              backgroundColor: hasTriage ? '#0a2e0a' : '#2e0a0a',
            }}
            onClick={onOpenTerminal}
          >
            {hasTriage ? '✅' : '⚠️'} 调度卡
            {!hasTriage && (
              <span style={{ fontSize: 9, color: '#f87171', display: 'block' }}>
                未分诊
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 问题分类图标 */
const CATEGORY_ICON: Record<string, string> = {
  consciousness: '🧠',
  breathing: '🫁',
  bleeding: '🩸',
  pain: '😣',
  age_gender: '👤',
  mechanism: '🔧',
}

/** 增强问询按钮 — 带层级颜色 + 时间代价徽章 + 终端回填提示 */
function AskBtnEx({
  id,
  label,
  icon,
  hintTerm,
  timeCost,
  done,
  disabled,
  tier,
  onClick,
}: {
  id: string
  label: string
  icon?: string
  hintTerm?: string
  timeCost: number
  done: boolean
  disabled?: boolean
  tier?: string
  onClick: () => void
}) {
  const ts = tier ? TIER_STYLE[tier] : undefined
  return (
    <button
      data-question-id={id}
      style={{
        ...styles.qBtn,
        backgroundColor: done ? '#1a3a1a' : disabled ? '#1e293b' : (ts?.bg ?? '#0f172a'),
        borderColor: done ? '#27ae60' : disabled ? '#334155' : (ts?.border ?? '#38bdf8'),
        color: done ? '#4ade80' : disabled ? '#475569' : '#e2e8f0',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled && !done ? 0.45 : 1,
        position: 'relative',
      }}
      onClick={onClick}
      disabled={disabled}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, justifyContent: 'center' }}>
        {done ? '✅ ' : icon ? icon + ' ' : ''}
        <span style={{ fontWeight: done ? 'normal' : 'bold', fontSize: 11 }}>{label}</span>
      </div>
      {!done && (
        <span style={{
          position: 'absolute',
          top: -5,
          right: -5,
          backgroundColor: ts?.badge ?? '#38bdf8',
          color: '#000',
          fontSize: 9,
          fontWeight: 900,
          padding: '1px 5px',
          borderRadius: 10,
          fontFamily: 'monospace',
        }}>
          {timeCost}s
        </span>
      )}
      {hintTerm && !done && (
        <div style={{ fontSize: 9, color: '#64748b', marginTop: 1, textAlign: 'center' }}>
          → {hintTerm}
        </div>
      )}
    </button>
  )
}

/** MPDS 调度卡弹出模态框 */
function TerminalModal({
  mpdsCard,
  terminal,
  dispatchSent,
  ambulanceRemaining,
  canDispatch,
  onChange,
  onSetStatus,
  onSetDeterminant,
  onTriage,
  onDispatch,
  onClose,
  onEndCall,
}: {
  mpdsCard: import('../game/types').MpdsProtocolCard
  terminal: TerminalState
  dispatchSent: boolean
  ambulanceRemaining: number
  canDispatch: boolean
  onChange: (field: TerminalField, value: string) => void
  onSetStatus: (field: 'conscious' | 'breathing', value: boolean) => void
  onSetDeterminant: (d: MpdsDeterminant) => void
  onTriage: (level: TriageLevel) => void
  onDispatch: () => void
  onClose: () => void
  onEndCall: () => void
}) {
  const protocolNum = terminal.protocolNumber ?? mpdsCard.number
  const modalRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const detCode = formatPlayerDeterminantCode(protocolNum, terminal.determinant)
  const hasTriage = terminal.triage !== null
  const hasDeterminant = terminal.determinant !== null
  const hasDispatchDecision = hasTriage && hasDeterminant

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    closeButtonRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }

      if (event.key !== 'Tab' || !modalRef.current) return
      const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      ))
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [onClose])

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mpds-dialog-title"
        style={styles.modalCard}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 模态框头部 */}
        <div style={styles.modalHeader}>
          <div style={styles.modalHeaderLeft}>
            <span style={styles.mpdsModalBadge}>协议 {protocolNum}</span>
            <div>
              <div id="mpds-dialog-title" style={{ fontSize: 15, fontWeight: 'bold', color: '#e2e8f0' }}>
                MPDS 调度终端
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>
                {mpdsCard.title} | 判定码：{detCode}
                {!terminal.determinant && '（待判定）'}
              </div>
            </div>
          </div>
          <div style={styles.modalHeaderRight}>
            <span style={{
              padding: '3px 12px',
              borderRadius: 12,
              fontSize: 12,
              fontWeight: 'bold',
              backgroundColor: terminal.hotCold === 'HOT'
                ? '#c0392b'
                : terminal.hotCold === 'COLD'
                  ? '#2e86c1'
                  : '#475569',
              color: '#fff',
            }}>
              {terminal.hotCold ?? '待判定'}
            </span>
            <button
              ref={closeButtonRef}
              style={styles.modalCloseBtn}
              onClick={onClose}
              title="关闭调度卡"
              aria-label="关闭调度卡"
            >
              ✕
            </button>
          </div>
        </div>

        {/* 模态框内容 */}
        <div style={styles.modalBody}>
          {/* 协议参考 */}
          <details style={styles.modalProtocolRef} open={false}>
            <summary style={{ fontSize: 11, color: '#38bdf8', cursor: 'pointer', fontWeight: 'bold' }}>
              📖 协议 {mpdsCard.number} 关键问题参考
            </summary>
            <div style={{ marginTop: 4 }}>
              {mpdsCard.keyQuestions.map((kq, i) => (
                <div key={i} style={{ fontSize: 11, color: '#94a3b8', padding: '2px 0' }}>
                  • {kq}
                </div>
              ))}
            </div>
          </details>

          {/* 终端登记表单 */}
          <div style={{ marginTop: 8 }}>
            <TerminalForm
              terminal={terminal}
              onChange={onChange}
              onSetStatus={onSetStatus}
              onSetDeterminant={onSetDeterminant}
              onTriage={onTriage}
            />
          </div>
        </div>

        {/* 模态框底部 — 操作按钮 */}
        <div style={styles.modalFooter}>
          {!dispatchSent ? (
            <>
              <button style={styles.modalEndCallBtn} onClick={onEndCall}>
                ✕ 挂断（骚扰电话）
              </button>
              <div style={{ flex: 1 }} />
              <button style={styles.modalSaveBtn} onClick={onClose}>
                📋 暂存关闭
              </button>
              <button
                style={{
                  ...styles.modalDispatchBtn,
                  opacity: hasDispatchDecision ? 1 : 0.5,
                  cursor: hasDispatchDecision ? 'pointer' : 'not-allowed',
                }}
                onClick={onDispatch}
                disabled={!hasDispatchDecision}
                title={!hasDispatchDecision ? '请先选择MPDS判定码和分诊等级' : '确认派车'}
              >
                🚑 确认派车
                {!hasDispatchDecision && <span style={{ display: 'block', fontSize: 10, opacity: 0.8 }}>← 请完成判定</span>}
              </button>
            </>
          ) : (
            <div style={styles.dispatchSent}>
              <span style={{ fontSize: 20 }}>🚑</span>
              <div>
                <div style={{ fontWeight: 'bold', color: '#2ecc71' }}>救护车已派出</div>
                {ambulanceRemaining > 0 ? (
                  <div style={{ color: '#e74c3c', fontSize: 12 }}>
                    预计 {ambulanceRemaining} 秒后到达现场
                  </div>
                ) : (
                  <div style={{ color: '#27ae60', fontSize: 12, fontWeight: 'bold' }}>
                    救护车已到达现场！
                  </div>
                )}
              </div>
              <button style={styles.modalCloseBtn} onClick={onClose}>✕ 关闭</button>
            </div>
          )}
        </div>

        {/* 未选分诊提示 */}
        {!hasDispatchDecision && !dispatchSent && canDispatch && (
          <div style={styles.modalWarning}>
            ⚠️ 请在下方选择 MPDS 判定码和分诊等级后，才能派出救护车
          </div>
        )}
      </div>
    </div>
  )
}

/** 急救指导面板 */
function GuidancePanel({
  guidance,
  stepIndex,
  results,
  onAnswer,
}: {
  guidance: import('../game/types').FirstAidGuidance
  stepIndex: number
  results: ('correct' | 'incorrect' | null)[]
  onAnswer: (stepIdx: number, selectedIdx: number) => void
}) {
  if (stepIndex >= guidance.steps.length) return null

  const currentStep = guidance.steps[stepIndex]
  const previousResults = results.slice(0, stepIndex)

  return (
    <div style={styles.guidancePanel}>
      <div style={styles.guidanceTitle}>🩺 {guidance.title}</div>
      {stepIndex === 0 && (
        <p style={styles.guidanceIntro}>{guidance.intro}</p>
      )}

      {/* 已完成步骤 */}
      {previousResults.map((r, i) => (
        <div
          key={i}
          style={{
            padding: '4px 8px',
            margin: '2px 0',
            backgroundColor: r === 'correct' ? '#0a2e0a' : '#2e0a0a',
            borderRadius: 4,
            fontSize: 13,
            color: r === 'correct' ? '#4ade80' : '#f87171',
          }}
        >
          {r === 'correct' ? '✅' : '❌'} 步骤{i + 1}：{guidance.steps[i].prompt}
        </div>
      ))}

      {/* 当前步骤 */}
      <div style={styles.guidanceStep}>
        <p style={styles.guidancePrompt}>
          步骤{stepIndex + 1}：{currentStep.prompt}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {currentStep.options.map((opt, i) => (
            <button
              key={i}
              style={styles.guidanceOption}
              onClick={() => onAnswer(stepIndex, i)}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** MPDS 标准调度登记卡 — 结构化病例录入（无自动提示，玩家自主判断） */
function TerminalForm({
  terminal,
  onChange,
  onSetStatus,
  onSetDeterminant,
  onTriage,
}: {
  terminal: TerminalState
  onChange: (field: TerminalField, value: string) => void
  onSetStatus: (field: 'conscious' | 'breathing', value: boolean) => void
  onSetDeterminant: (d: MpdsDeterminant) => void
  onTriage: (level: TriageLevel) => void
}) {
  return (
    <div style={styles.terminalForm}>
      {/* ====== Case Entry（病例录入） ====== */}
      <SectionTitle icon="📋" text="病例录入 (Protocol 0)" />

      {/* 地址 */}
      <FieldRow inputId="terminal-address" icon="📍" label="事件地址">
        <textarea
          id="terminal-address"
          style={styles.formInput}
          value={terminal.address}
          onChange={(e) => onChange('address', e.target.value)}
          placeholder="记录详细地址…"
          rows={2}
        />
      </FieldRow>

      {/* 联系电话 */}
      <FieldRow inputId="terminal-contact" icon="📞" label="联系电话">
        <input
          id="terminal-contact"
          style={{ ...styles.formInput, height: 30 }}
          value={terminal.contact}
          onChange={(e) => onChange('contact', e.target.value)}
          placeholder="记录联系方式…"
        />
      </FieldRow>

      {/* 主诉 */}
      <FieldRow inputId="terminal-complaint" icon="🩺" label="主诉 (Chief Complaint)">
        <input
          id="terminal-complaint"
          style={{ ...styles.formInput, height: 30 }}
          value={terminal.chiefComplaint}
          onChange={(e) => onChange('chiefComplaint', e.target.value)}
          placeholder="标准化主诉…"
        />
      </FieldRow>

      {/* 患者基本信息 */}
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ flex: 1 }}>
          <FieldRow inputId="terminal-age" icon="👤" label="年龄">
            <input
              id="terminal-age"
              style={{ ...styles.formInput, height: 28 }}
              value={terminal.patientAge}
              onChange={(e) => onChange('patientAge', e.target.value)}
              placeholder="…"
            />
          </FieldRow>
        </div>
        <div style={{ flex: 1 }}>
          <FieldRow inputId="terminal-gender" icon="⚧" label="性别">
            <input
              id="terminal-gender"
              style={{ ...styles.formInput, height: 28 }}
              value={terminal.patientGender}
              onChange={(e) => onChange('patientGender', e.target.value)}
              placeholder="…"
            />
          </FieldRow>
        </div>
      </div>

      {/* ====== 患者生命体征 — 关键问题 ====== */}
      <SectionTitle icon="💓" text="关键问题 (Key Questions)" />

      {/* 意识状态 */}
      <StatusToggle
        label="意识状态"
        field="conscious"
        value={terminal.conscious}
        trueLabel="有意识"
        falseLabel="无意识"
        colorTrue="#27ae60"
        colorFalse="#e74c3c"
        onToggle={onSetStatus}
      />

      {/* 呼吸状态 */}
      <StatusToggle
        label="呼吸状态"
        field="breathing"
        value={terminal.breathing}
        trueLabel="正常呼吸"
        falseLabel="无呼吸/异常"
        colorTrue="#27ae60"
        colorFalse="#e74c3c"
        onToggle={onSetStatus}
      />

      {/* ====== 判定码 (Determinant) ====== */}
      <SectionTitle icon="🎯" text="MPDS 判定码" />
      <DeterminantSelector
        current={terminal.determinant}
        onSelect={onSetDeterminant}
      />

      {/* ====== 分诊等级 — 四色映射 ====== */}
      <SectionTitle icon="🚨" text="现场分诊等级" />
      <div style={styles.triageGrid}>
        {TRIAGE_OPTIONS.map((opt) => (
          <button
            key={opt.level}
            style={{
              ...styles.triageBtn,
              borderColor: opt.color,
              backgroundColor: terminal.triage === opt.level ? opt.color : 'transparent',
              color: terminal.triage === opt.level ? '#fff' : opt.color,
            }}
            onClick={() => onTriage(opt.level)}
            aria-pressed={terminal.triage === opt.level}
          >
            <div style={{ fontWeight: 'bold', fontSize: 14 }}>{opt.label}</div>
            <div style={{ fontSize: 10 }}>{opt.desc}</div>
          </button>
        ))}
      </div>

      {/* ====== 备注 ====== */}
      <SectionTitle icon="📝" text="事件备注" />
      <textarea
        aria-label="事件备注"
        style={styles.formInput}
        value={terminal.conditionNote}
        onChange={(e) => onChange('conditionNote', e.target.value)}
        placeholder="记录其他重要信息…"
        rows={2}
      />
    </div>
  )
}

/** 小标题 */
function SectionTitle({ icon, text }: { icon: string; text: string }) {
  return (
    <div style={{
      fontSize: 12,
      fontWeight: 'bold',
      color: '#94a3b8',
      borderBottom: '1px solid #334155',
      padding: '6px 0 3px',
      marginBottom: 4,
      letterSpacing: 0.5,
      textTransform: 'uppercase',
    }}>
      {icon} {text}
    </div>
  )
}

/** 单行输入框 */
function FieldRow({
  inputId,
  icon,
  label,
  children,
}: {
  inputId: string
  icon: string
  label: string
  children: React.ReactNode
}) {
  return (
    <div style={{ marginBottom: 6 }}>
      <label htmlFor={inputId} style={styles.formLabel}>
        {icon} {label}
      </label>
      {children}
    </div>
  )
}

/** 生命体征切换器 — 带信息质量标记 */
function StatusToggle({
  label,
  field,
  value,
  trueLabel,
  falseLabel,
  colorTrue,
  colorFalse,
  onToggle,
}: {
  label: string
  field: 'conscious' | 'breathing'
  value: boolean | null
  trueLabel: string
  falseLabel: string
  colorTrue: string
  colorFalse: string
  onToggle: (field: 'conscious' | 'breathing', val: boolean) => void
}) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={styles.formLabel}>{label}</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          style={{
            flex: 1,
            padding: '4px 8px',
            borderRadius: 4,
            border: `1px solid ${colorTrue}`,
            backgroundColor: value === true ? colorTrue : 'transparent',
            color: value === true ? '#fff' : colorTrue,
            fontSize: 12,
            cursor: 'pointer',
            fontWeight: value === true ? 'bold' : 'normal',
            minHeight: 44,
          }}
          onClick={() => onToggle(field, true)}
          aria-pressed={value === true}
        >
          {trueLabel}
        </button>
        <button
          style={{
            flex: 1,
            padding: '4px 8px',
            borderRadius: 4,
            border: `1px solid ${colorFalse}`,
            backgroundColor: value === false ? colorFalse : 'transparent',
            color: value === false ? '#fff' : colorFalse,
            fontSize: 12,
            cursor: 'pointer',
            fontWeight: value === false ? 'bold' : 'normal',
            minHeight: 44,
          }}
          onClick={() => onToggle(field, false)}
          aria-pressed={value === false}
        >
          {falseLabel}
        </button>
      </div>
    </div>
  )
}

/** MPDS 判定码选择器 — Echo/Delta/Charlie/Bravo/Alpha */
function DeterminantSelector({
  current,
  onSelect,
}: {
  current: MpdsDeterminant | null
  onSelect: (d: MpdsDeterminant) => void
}) {
  const levels: { key: MpdsDeterminant; label: string; desc: string }[] = [
    { key: 'ECHO', label: 'E-ECHO', desc: '即刻生命威胁' },
    { key: 'DELTA', label: 'D-DELTA', desc: '高危/潜在致命' },
    { key: 'CHARLIE', label: 'C-CHARLIE', desc: '中危/需ALS' },
    { key: 'BRAVO', label: 'B-BRAVO', desc: '低中危/BLS' },
    { key: 'ALPHA', label: 'A-ALPHA', desc: '低危/转运' },
  ]

  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 4, flexWrap: 'wrap' }}>
      {levels.map((l) => {
        const info = MPDS_DETERMINANT_INFO[l.key]
        const isActive = current === l.key
        return (
          <button
            key={l.key}
            title={info.responseCode}
            style={{
              flex: '1 0 auto',
              padding: '4px 6px',
              borderRadius: 4,
              border: `2px solid ${info.color}`,
              backgroundColor: isActive ? info.color : 'transparent',
              color: isActive ? '#fff' : info.color,
              fontSize: 11,
              fontWeight: isActive ? 'bold' : 'normal',
              cursor: 'pointer',
              minWidth: 50,
              minHeight: 44,
            }}
            onClick={() => onSelect(l.key)}
            aria-pressed={isActive}
          >
            <div style={{ fontWeight: 'bold' }}>{l.label}</div>
            <div style={{ fontSize: 9, opacity: 0.85 }}>{l.desc}</div>
          </button>
        )
      })}
    </div>
  )
}

// ============================================================
// 样式
// ============================================================

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: '100vw',
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#1a1a2e',
    color: '#333',
    overflow: 'hidden',
  },

  // ---------- 电话面板（全宽）----------
  phonePanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#0f172a',
    overflow: 'hidden',
    minHeight: 0,
    border: '1px solid #1e293b',
  },

  phoneHeader: {
    padding: '8px 12px',
    backgroundColor: '#020617',
    borderBottom: '2px solid #ef4444',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  // LIVE 指示器行
  callLiveBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  liveDot: {
    fontSize: 10,
    color: '#ef4444',
    animation: 'pulse-live 1s ease-in-out infinite',
    display: 'inline-block',
  },
  liveLabel: {
    fontSize: 11,
    fontWeight: 900,
    color: '#ef4444',
    fontFamily: 'monospace',
    letterSpacing: 2,
    textTransform: 'uppercase' as const,
  },
  callTimer: {
    fontSize: 22,
    fontWeight: 700,
    fontFamily: 'monospace',
    letterSpacing: 2,
  },
  targetBadge: {
    marginLeft: 'auto',
    padding: '2px 8px',
    borderRadius: 10,
    border: '1px solid',
    fontSize: 10,
    fontWeight: 700,
    fontFamily: 'monospace',
  },
  phoneHeaderInfo: {
    fontSize: 11,
    display: 'flex',
    gap: 6,
    color: '#94a3b8',
    fontFamily: 'monospace',
  },
  callPhaseTag: {
    fontSize: 10,
    color: '#64748b',
    fontFamily: 'monospace',
  },

  // ---------- 对话区 — 通话逐字稿 ----------
  dialogueArea: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    minHeight: 0,
    backgroundColor: '#0a0e17',
  },

  transcript: {
    fontSize: 13,
    lineHeight: 1.6,
    fontFamily: '"Source Code Pro", "Consolas", "Courier New", monospace',
    padding: '2px 0',
    borderBottom: '1px solid #1a1f2e',
  },
  transcriptSpeaker: {
    display: 'inline',
    fontWeight: 700,
    marginRight: 6,
    fontSize: 12,
  },
  transcriptText: {
    display: 'inline',
  },
  streamCursor: {
    display: 'inline-block',
    color: '#f87171',
    fontSize: 13,
    marginLeft: 0,
    animation: 'pulse-live 0.7s step-end infinite',
    verticalAlign: 'baseline',
  },

  // ---------- 问询区域 ----------
  questionArea: {
    borderTop: '1px solid #1e293b',
    padding: '6px 10px',
    backgroundColor: '#020617',
    maxHeight: 320,
    overflowY: 'auto' as const,
  },
  // 来电者压力条
  stressBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '2px 0',
  },
  stressTrack: {
    flex: 1,
    height: 7,
    backgroundColor: '#1e293b',
    borderRadius: 4,
    overflow: 'hidden',
  },
  stressFill: {
    height: '100%',
    borderRadius: 4,
    transition: 'width 0.5s ease, background-color 0.3s ease',
  },
  bottomToolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap' as const,
    gap: 6,
    padding: '6px 10px',
    borderTop: '1px solid #1e293b',
    backgroundColor: '#020617',
  },
  terminalBtn: {
    padding: '6px 14px',
    borderRadius: 6,
    border: '2px solid',
    backgroundColor: 'transparent',
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: 'bold',
    cursor: 'pointer',
    fontFamily: 'monospace',
    letterSpacing: 0.5,
    transition: 'all 0.2s',
    minHeight: 44,
  },
  calmBtn: {
    padding: '3px 10px',
    borderRadius: 4,
    border: '1px solid #38bdf8',
    backgroundColor: '#0c4a6e',
    color: '#e2e8f0',
    fontSize: 11,
    fontWeight: 'bold',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    minHeight: 44,
  },
  // 协议卡参考清单
  qRefCard: {
    backgroundColor: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 6,
    padding: '6px 10px',
    marginBottom: 6,
  },
  qRefHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  qRefProto: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#38bdf8',
    fontFamily: 'monospace',
  },
  qRefBadge: {
    padding: '1px 8px',
    borderRadius: 10,
    fontSize: 10,
    fontWeight: 'bold',
    color: '#fff',
    fontFamily: 'monospace',
  },
  qRefList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 1,
  },
  qRefItem: {
    fontSize: 11,
    color: '#94a3b8',
    lineHeight: '1.4',
    paddingLeft: 4,
  },
  qRefDot: {
    color: '#38bdf8',
    marginRight: 4,
  },
  qSection: {
    marginBottom: 6,
  },

  // ---------- 5步协议步骤列表 ----------
  protocolStepsList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
    marginBottom: 4,
  },
  protocolStepRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid',
    transition: 'all 0.25s',
  },
  protocolStepNum: {
    width: 26,
    height: 26,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    fontWeight: 900,
    fontFamily: 'monospace',
    flexShrink: 0,
  },
  protocolStepBtn: {
    padding: '4px 12px',
    borderRadius: 4,
    border: 'none',
    backgroundColor: '#fbbf24',
    color: '#000',
    fontSize: 11,
    fontWeight: 'bold',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    transition: 'all 0.15s',
    fontFamily: 'monospace',
    minHeight: 44,
  },
  qBtnSmall: {
    padding: '3px 8px',
    borderRadius: 4,
    border: '1px solid',
    fontSize: 11,
    lineHeight: '1.3',
    textAlign: 'center' as const,
  },

  qSectionTitle: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#64748b',
    marginBottom: 3,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    borderBottom: '1px solid #1e293b',
    paddingBottom: 2,
  },
  qGrid: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 4,
  },
  qBtn: {
    padding: '3px 8px',
    borderRadius: 4,
    border: '1px solid',
    fontSize: 11,
    transition: 'all 0.15s',
    lineHeight: '1.3',
    minHeight: 44,
  },

  // ---------- 急救指导 ----------
  guidancePanel: {
    borderTop: '2px solid #ef4444',
    padding: '10px 14px',
    backgroundColor: '#1a0a0a',
    maxHeight: 300,
    overflowY: 'auto' as const,
  },
  guidanceTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#f87171',
    marginBottom: 8,
  },
  guidanceIntro: {
    fontSize: 13,
    color: '#94a3b8',
    marginBottom: 8,
    padding: '6px 10px',
    backgroundColor: '#1e1a0a',
    borderRadius: 4,
  },
  guidanceStep: {
    marginTop: 8,
  },
  guidancePrompt: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#e2e8f0',
    marginBottom: 4,
  },
  guidanceOption: {
    padding: '6px 12px',
    border: '1px solid #334155',
    borderRadius: 4,
    backgroundColor: '#1e293b',
    cursor: 'pointer',
    fontSize: 13,
    color: '#e2e8f0',
    textAlign: 'left' as const,
    transition: 'all 0.15s',
    minHeight: 44,
  },

  // ---------- 收尾 ----------
  closingPanel: {
    borderTop: '1px solid #1e293b',
    padding: '12px 14px',
    backgroundColor: '#020617',
    textAlign: 'center' as const,
  },
  endCallBtn: {
    padding: '8px 24px',
    backgroundColor: '#dc2626',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    fontSize: 14,
    fontWeight: 'bold',
    cursor: 'pointer',
    minHeight: 44,
  },

  // ---------- MPDS 调度卡模态框 ----------
  modalOverlay: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 1000,
    backgroundColor: 'rgba(0,0,0,0.75)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backdropFilter: 'blur(2px)',
  },
  modalCard: {
    width: 'min(560px, calc(100vw - 24px))',
    maxHeight: '90vh',
    backgroundColor: '#0f172a',
    borderRadius: 10,
    border: '1px solid #334155',
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
    boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 0 2px #ef4444',
  },
  modalHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    backgroundColor: '#020617',
    borderBottom: '2px solid #ef4444',
  },
  modalHeaderLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  modalHeaderRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  mpdsModalBadge: {
    backgroundColor: '#1e293b',
    border: '2px solid #38bdf8',
    borderRadius: 6,
    padding: '6px 12px',
    color: '#38bdf8',
    fontSize: 16,
    fontWeight: 900,
    fontFamily: 'monospace',
  },
  modalCloseBtn: {
    padding: '4px 10px',
    backgroundColor: 'transparent',
    color: '#94a3b8',
    border: '1px solid #475569',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 'bold',
    minWidth: 44,
    minHeight: 44,
  },
  modalBody: {
    flex: 1,
    padding: '10px 16px',
    overflowY: 'auto' as const,
    minHeight: 0,
  },
  modalProtocolRef: {
    backgroundColor: '#1a2233',
    border: '1px solid #334155',
    borderRadius: 6,
    padding: '6px 10px',
  },
  // ---------- 临床判断卡（内联在对话旁）----------
  judgmentCard: {
    marginLeft: 32,
    marginTop: 4,
    marginBottom: 8,
    padding: '8px 10px',
    borderRadius: 8,
    border: '2px solid',
    backgroundColor: '#0b1320',
    animation: 'slide-in-right 0.3s ease-out',
    maxWidth: 460,
  },
  judgmentHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
    fontSize: 11,
    fontWeight: 'bold',
    color: '#fbbf24',
  },
  judgmentIcon: {
    fontSize: 14,
  },
  judgmentQuestion: {
    flex: 1,
  },
  judgmentOptions: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  judgmentOption: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid',
    fontSize: 12,
    textAlign: 'left' as const,
    transition: 'all 0.15s',
    fontFamily: 'inherit',
  },
  judgmentOptionMarker: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 20,
    height: 20,
    borderRadius: '50%',
    backgroundColor: '#1e293b',
    fontSize: 11,
    fontWeight: 'bold',
    color: '#94a3b8',
    flexShrink: 0,
    marginTop: 1,
  },
  modalFooter: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 16px',
    borderTop: '1px solid #334155',
    backgroundColor: '#020617',
    flexWrap: 'wrap' as const,
  },
  modalDispatchBtn: {
    padding: '10px 24px',
    backgroundColor: '#dc2626',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    fontSize: 15,
    fontWeight: 'bold',
    cursor: 'pointer',
    transition: 'all 0.15s',
    minHeight: 44,
  },
  modalSaveBtn: {
    padding: '8px 16px',
    backgroundColor: '#1e293b',
    color: '#94a3b8',
    border: '1px solid #475569',
    borderRadius: 6,
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 44,
  },
  modalEndCallBtn: {
    padding: '8px 12px',
    backgroundColor: 'transparent',
    color: '#94a3b8',
    border: '1px solid #475569',
    borderRadius: 6,
    fontSize: 11,
    cursor: 'pointer',
    minHeight: 44,
  },
  modalWarning: {
    padding: '6px 16px',
    backgroundColor: '#2e0a0a',
    borderTop: '1px solid #ef4444',
    color: '#f87171',
    fontSize: 12,
    fontWeight: 'bold',
    textAlign: 'center' as const,
  },

  // ---------- 终端登记表单（模态框内复用）----------
  terminalForm: {
    padding: '0',
  },

  dispatchSent: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 12px',
    backgroundColor: '#0f172a',
    borderRadius: 6,
    border: '1px solid #2ecc71',
    flex: 1,
  },

  formField: {
    marginBottom: 10,
  },
  formLabel: {
    display: 'block',
    fontSize: 12,
    fontWeight: 'bold',
    color: '#94a3b8',
    marginBottom: 4,
  },
  formInput: {
    width: '100%',
    padding: '6px 10px',
    borderRadius: 4,
    border: '1px solid #334155',
    backgroundColor: '#0f172a',
    color: '#e2e8f0',
    fontSize: 12,
    fontFamily: 'monospace',
    resize: 'vertical' as const,
    boxSizing: 'border-box' as const,
    minHeight: 44,
  },

  triageGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 4,
  },
  triageBtn: {
    padding: '6px 8px',
    borderRadius: 4,
    border: '2px solid',
    cursor: 'pointer',
    fontSize: 12,
    transition: 'all 0.15s',
    minHeight: 44,
  },

  // ---------- 等待接听 — 紧急调度台 ----------
  centerMessage: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: '#0a0e17',
  },
  answerBtn: {
    padding: '14px 48px',
    fontSize: 20,
    fontWeight: 'bold',
    backgroundColor: '#dc2626',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    animation: 'pulse-alert 1.5s ease-in-out infinite',
    letterSpacing: 4,
  },
}
