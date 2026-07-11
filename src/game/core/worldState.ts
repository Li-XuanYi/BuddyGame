// ============================================================
// 零点接线台 — WorldState 工厂函数
// ============================================================

import type { WorldState, CallerState, TerminalState, TriageLevel } from '../types'
import { stressToLevel } from '../types'
import { SCENARIO_IDS } from '../events/templates'

/** 创建空白的来电者追踪状态 */
export function createCallerState(callerId: string, initialStress = 40): CallerState {
  return {
    id: callerId,
    cooperation: 80,
    stress: initialStress,
    stressLevel: stressToLevel(initialStress),
    revealedInfo: {
      address: 'none',
      contact: false,
      chiefComplaint: false,
      age: false,
      gender: false,
      consciousness: false,
      breathing: false,
      additional: [],
      purpose: false,
    },
    infoQuality: {},
    askedMPDS: [],
    questionCount: 0,
  }
}

/** 创建空白的终端状态 */
export function createTerminalState(): TerminalState {
  return {
    address: '',
    contact: '',
    chiefComplaint: '',
    patientAge: '',
    patientGender: '',
    conscious: null,
    breathing: null,
    protocolNumber: null,
    determinant: null,
    triage: null,
    hotCold: null,
    conditionNote: '',
  }
}

/** 打乱数组（Fisher-Yates） */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** 获取本班次的场景队列（随机打乱顺序） */
export function buildScenarioQueue(shiftNumber: number): string[] {
  // 每个班次5通电话，从所有场景中随机选5个
  const pool = [...SCENARIO_IDS]
  const shuffled = shuffle(pool)
  const selected = shuffled.slice(0, 5)

  // 恶作剧电话不能作为班次最后一通，避免用最简单的题目收尾。
  const lastIndex = selected.length - 1
  if (selected[lastIndex] === 'prank_call' && lastIndex > 0) {
    const swapIndex = shiftNumber % lastIndex
    ;[selected[swapIndex], selected[lastIndex]] = [selected[lastIndex], selected[swapIndex]]
  }

  return selected
}

/** 创建初始世界状态 */
export function createInitialState(): WorldState {
  return {
    screen: 'title',
    shiftNumber: 0,
    callIndex: 0,
    totalCalls: 5,
    scenarioQueue: [],
    shiftElapsed: 0,
    currentCall: null,
    callPhase: 'ringing',
    callStartTime: 0,
    callerState: null,
    questionCost: 0,
    terminal: createTerminalState(),
    dispatchSent: false,
    dispatchRecord: null,
    ambulanceRemaining: -1,
    guidanceActive: false,
    guidanceStepIndex: 0,
    guidanceResults: [],
    dialogueLog: [],
    pendingJudgments: [],
    totalScore: 0,
    callScores: [],
    endingId: null,
  }
}

// ============================================================
// 派车计时与ETA计算
// ============================================================

/**
 * 计算救护车预计到达时间（游戏秒数）
 * 受派车速度和地址完整度影响
 */
export function calcAmbulanceETA(
  dispatchTime: number,
  addressCompleteness: 'vague' | 'partial' | 'full',
): number {
  // 基础ETA（游戏压缩后的时间）
  let eta = 8

  // 派车越快，ETA越短
  if (dispatchTime <= 27) {
    eta -= 2
  } else if (dispatchTime <= 43) {
    eta -= 1
  } else if (dispatchTime > 60) {
    eta += 2
  }

  // 地址越完整，ETA越短
  if (addressCompleteness === 'vague') {
    eta += 3
  } else if (addressCompleteness === 'partial') {
    eta += 1
  }
  // full: no penalty

  return Math.max(3, eta)
}

// ============================================================
// 单通电话评分
// ============================================================

export interface CallScore {
  speed: number       // 派车速度分（0-40）
  info: number        // 四要素完整度分（0-30）
  triage: number      // 分诊准确度分（0-20）
  guidance: number    // 急救指导分（0-10）
  total: number
}

export function scoreCall(
  dispatchTime: number | null,
  addressCompleteness: 'vague' | 'partial' | 'full',
  hasContact: boolean,
  hasCondition: boolean,
  hasPurpose: boolean,
  triageDecision: TriageLevel | null,
  correctTriage: TriageLevel,
  guidanceCorrect: number,
  guidanceTotal: number,
  infoQualityBonus = 0,
): CallScore {
  // 1. 派车速度分（0-40）— 问询会真实推进游戏时钟，因此直接使用派车耗时。
  const netTime = dispatchTime
  let speed = 0
  if (netTime !== null) {
    if (netTime <= 27) speed = 40
    else if (netTime <= 43) speed = 35
    else if (netTime <= 60) speed = 25
    else if (netTime <= 90) speed = 15
    else speed = 5
  }

  // 2. 四要素信息分（0-30） + 信息质量加分
  let info = 0
  if (addressCompleteness === 'full') info += 10
  else if (addressCompleteness === 'partial') info += 6
  else if (addressCompleteness === 'vague') info += 3
  if (hasContact) info += 5
  if (hasCondition) info += 10
  if (hasPurpose) info += 5

  // 信息质量加分（最多+5）
  info = Math.min(30, info + infoQualityBonus)

  // 3. 分诊准确度分（0-20）
  let triage = 0
  if (triageDecision === correctTriage) {
    triage = 20
  } else if (triageDecision && correctTriage) {
    const order = ['red', 'yellow', 'green', 'black'] as const
    const diff = Math.abs(order.indexOf(triageDecision) - order.indexOf(correctTriage))
    if (diff === 1) triage = 10
    else triage = 0
  }

  // 4. 急救指导分（0-10）
  let guidance = 0
  if (guidanceTotal > 0) {
    guidance = Math.round((guidanceCorrect / guidanceTotal) * 10)
  }

  const total = speed + info + triage + guidance
  return { speed, info, triage, guidance, total }
}
