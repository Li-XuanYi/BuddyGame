// ============================================================
// 零点接线台 — World Reducer
// 120急救调度模拟游戏核心逻辑
// ============================================================

import type { WorldState, DialogueLine, InfoQuality, JudgmentPrompt, MpdsDeterminant } from '../types'
import { stressToLevel } from '../types'
import type { GameAction } from './actions'
import {
  createInitialState,
  createCallerState,
  createTerminalState,
  buildScenarioQueue,
  calcAmbulanceETA,
  scoreCall,
} from './worldState'
import { getScenario } from '../events/templates'
import { getCaller } from '../npc/personas'

/** 根据情绪选择叙述式回答 */
function pickNarrativeAnswer(
  stress: number,
  cleanAnswer: string,
  ramblingAnswer: string,
  panickedAnswer: string,
): { text: string; quality: InfoQuality; distorted: boolean } {
  if (stress >= 75) return { text: panickedAnswer, quality: 'vague', distorted: true }
  if (stress >= 50) return { text: ramblingAnswer, quality: 'partial', distorted: true }
  if (stress >= 25) return { text: ramblingAnswer, quality: 'partial', distorted: false }
  return { text: cleanAnswer, quality: 'clear', distorted: false }
}

/** 由来电者tone映射初始压力值 */
function toneToInitialStress(tone: string): number {
  const map: Record<string, number> = {
    panic: 70,
    anxious: 50,
    calm: 25,
    confused: 40,
    hysterical: 85,
    angry: 60,
  }
  return map[tone] ?? 40
}

/** 从 9-E-1 一类 MPDS 判定码推导玩家应选择的判定等级。 */
function determinantFromCode(code: string): MpdsDeterminant | null {
  const letter = code.split('-')[1]?.toUpperCase()
  const map: Record<string, MpdsDeterminant> = {
    E: 'ECHO',
    D: 'DELTA',
    C: 'CHARLIE',
    B: 'BRAVO',
    A: 'ALPHA',
  }
  return letter ? (map[letter] ?? null) : null
}

/** 错误或遗漏的临床判断会真实影响单通电话得分。 */
function calculateDecisionPenalty(
  judgments: JudgmentPrompt[],
  expectedDeterminant: MpdsDeterminant | null,
  selectedDeterminant: MpdsDeterminant | null,
  expectedConscious: boolean | null,
  selectedConscious: boolean | null,
  expectedBreathing: boolean | null,
  selectedBreathing: boolean | null,
): number {
  let penalty = 0

  for (const judgment of judgments) {
    if (judgment.chosenOptionIndex === null) {
      penalty += 3
      continue
    }

    if (!judgment.options[judgment.chosenOptionIndex]?.isCorrect) {
      penalty += 5
    }
  }

  if (expectedDeterminant && selectedDeterminant !== expectedDeterminant) {
    penalty += 5
  }

  if (expectedConscious !== null && selectedConscious !== expectedConscious) {
    penalty += 3
  }

  if (expectedBreathing !== null && selectedBreathing !== expectedBreathing) {
    penalty += 3
  }

  return Math.min(20, penalty)
}

function expectedVital(
  call: WorldState['currentCall'],
  field: 'conscious' | 'breathing',
): boolean | null {
  if (!call) return null
  const consciousness = call.fourElements.condition.consciousness
  const breathing = call.fourElements.condition.breathing
  const isUnconscious = consciousness.includes('无意识')
    || consciousness.includes('不醒')
    || consciousness.includes('呼之不应')
    || consciousness.includes('昏迷')
  const isBreathingAbnormal = breathing.includes('没有呼吸')
    || breathing.includes('无呼吸')
    || breathing.includes('窒息')
    || breathing.includes('胸口不动')
    || breathing.includes('急促')
    || breathing.includes('喘')
    || breathing.includes('异常')

  return field === 'conscious' ? !isUnconscious : !isBreathingAbnormal
}

/** 生成步骤1（位置确认）的叙述式回答 */
function generateLocationNarrative(
  partial: string,
  vague: string,
  stress: number,
): { text: string; quality: InfoQuality; distorted: boolean } {
  if (stress >= 75) return { text: vague, quality: 'vague', distorted: true }
  if (stress >= 50) {
    const shortVague = vague.length > 6 ? vague.slice(0, 6) : vague
    return {
      text: `${partial.split('，')[0]}！！你们快来！！就在${shortVague}这边！！`,
      quality: 'partial', distorted: true,
    }
  }
  if (stress >= 25) {
    const areaHint = vague.length > 4 ? vague.slice(0, 4) : vague
    return {
      text: `在...在${areaHint}...不对，是在${partial}...对，就是这个地址。`,
      quality: 'partial', distorted: false,
    }
  }
  return { text: partial, quality: 'clear', distorted: false }
}

/** 生成步骤2（事件简述）的叙述式回答 */
function generateEventNarrative(
  chiefComplaint: string,
  gender: string,
  stress: number,
  relationship: string,
): { text: string; quality: InfoQuality; distorted: boolean } {
  const pronoun = gender === '女性' ? '她' : gender === '男性' ? '他' : 'TA'
  // 根据来电者与患者的关系推导自然的情景描述
  const context =
    relationship === '路人' ? '就在路边' :
    relationship === '同事' ? '我们正在做事' :
    '刚才还好好的在'

  if (stress >= 75) {
    return {
      text: `不行了不行了！！${pronoun}${chiefComplaint.slice(0, 8)}...你们快来啊！！出大事了！！`,
      quality: 'vague', distorted: true,
    }
  }
  if (stress >= 50) {
    return {
      text: `${pronoun}...我...我不知道怎么形容...${chiefComplaint.slice(0, 10)}...就是突然之间就不对劲了！${context}...一下子就...我该怎么办？！`,
      quality: 'partial', distorted: true,
    }
  }
  if (stress >= 25) {
    return {
      text: `${pronoun}${chiefComplaint.slice(0, 15)}...就是这样的情况，刚刚发生的，感觉挺严重的。嗯...大概就是这样。`,
      quality: 'partial', distorted: false,
    }
  }
  return { text: chiefComplaint, quality: 'clear', distorted: false }
}

/** 生成步骤3（患者人数）的叙述式回答 */
function generateCountNarrative(count: string, stress: number): string {
  if (stress >= 75) return `${count}！！！就${count}！！我不知道还有没有别的！！！`
  if (stress >= 50) return `${count}...应该就是${count}吧，没有别人了...应该...我太慌了没注意看周围。`
  if (stress >= 25) return `${count}，就是${count}。没别人了。`
  return `${count}。`
}

/** 生成步骤4（患者年龄）的叙述式回答 */
function generateAgeNarrative(age: string, stress: number, gender: string): string {
  const pronoun = gender === '女性' ? '她' : gender === '男性' ? '他' : 'TA'
  // 防御性剥离：确保 age 字段不混入性别/称谓
  const cleanAge = age.replace(/男性|女性|男|女|不详/g, '').trim()
  if (stress >= 75) return `${pronoun}${cleanAge}！！具体多少有关系吗？！快派人来啊！！`
  if (stress >= 50) return `${pronoun}${cleanAge}...应该是${cleanAge}吧，我一下子脑子转不过来了...这有关系吗？`
  if (stress >= 25) return `${pronoun}${cleanAge}...应该差不多。`
  return `${pronoun}${cleanAge}。`
}

/** 生成步骤5（意识与呼吸）的叙述式回答 */
function generateVitalsNarrative(consciousness: string, breathing: string, stress: number): string {
  if (stress >= 75) {
    const c = consciousness.length > 10 ? consciousness.slice(0, 10) + '...' : consciousness
    const b = breathing.length > 10 ? breathing.slice(0, 10) + '...' : breathing
    return `${c}！！！${b}！！！你们快来啊！！！`
  }
  if (stress >= 50) return `${consciousness}...${breathing}...天哪我不知道怎么形容...反正看起来不太好...`
  if (stress >= 25) return `${consciousness}，${breathing}...应该...应该是这样的...`
  return `${consciousness}，${breathing}。`
}

export function worldReducer(state: WorldState, action: GameAction): WorldState {
  switch (action.type) {

    // ==========================================
    // START_SHIFT — 开始新班次
    // ==========================================
    case 'START_SHIFT': {
      const newShift = state.shiftNumber + 1
      return {
        ...createInitialState(),
        screen: 'playing',
        shiftNumber: newShift,
        scenarioQueue: buildScenarioQueue(newShift),
        // 为恶作剧电话设置标记：最后2通不能是恶作剧（太简单）
      }
    }

    // ==========================================
    // ANSWER_CALL — 接听电话
    // ==========================================
    case 'ANSWER_CALL': {
      if (state.callIndex >= state.totalCalls) return state

      const scenarioId = state.scenarioQueue[state.callIndex]
      if (!scenarioId) return state

      const scenario = getScenario(scenarioId)
      const callerProfile = getCaller(scenario.callerId)
      const initialStress = toneToInitialStress(callerProfile.tone)
      const callerState = createCallerState(scenario.callerId, initialStress)

      const openingLine: DialogueLine = {
        speaker: 'caller',
        text: scenario.openingLine,
        timestamp: state.shiftElapsed,
      }

      const systemLine: DialogueLine = {
        speaker: 'system',
        text: `【来电号码: ${scenario.phoneNumber} | 基站定位: ${scenario.baseStation} | 来电者情绪: ${callerState.stressLevel}】`,
        timestamp: state.shiftElapsed,
      }

      // 终端不再自动填入 — 玩家从对话中提取
      const terminal = createTerminalState()
      terminal.protocolNumber = scenario.mpdsCard.number

      return {
        ...state,
        currentCall: scenario,
        callPhase: 'questioning',
        callStartTime: state.shiftElapsed,
        questionCost: 0,
        callerState,
        terminal,
        dispatchSent: false,
        dispatchRecord: null,
        ambulanceRemaining: -1,
        guidanceActive: false,
        guidanceStepIndex: 0,
        guidanceResults: [],
        pendingJudgments: [],
        dialogueLog: [systemLine, openingLine],
      }
    }

    // ==========================================
    // ASK_QUESTION — 叙述式问询：来电者絮叨回答，玩家需从混乱中摘取关键信息
    // ==========================================
    case 'ASK_QUESTION': {
      const { questionId } = action
      const call = state.currentCall
      const cs = state.callerState
      if (!call || !cs) return state
      if (state.callPhase !== 'questioning' && state.callPhase !== 'connected') return state
      if (cs.askedMPDS.includes(questionId)) return state

      const now = state.shiftElapsed
      const newDialogue: DialogueLine[] = []
      const newRevealed = { ...cs.revealedInfo }
      const newInfoQuality: Record<string, InfoQuality> = { ...cs.infoQuality }
      const newAskedMPDS = [...cs.askedMPDS]
      let newAddress: 'none' | 'vague' | 'partial' | 'full' = newRevealed.address
      let newStress = cs.stress
      let timeCost = 0
      let stressEffect = 0
      const newJudgments: JudgmentPrompt[] = [...(state.pendingJudgments ?? [])]
      let newTerminal = { ...state.terminal }

      // ==========================================
      // 5步标准协议 (Protocol 0) — 每通电话必须依次完成
      // ==========================================

      // --- 步骤1：位置确认 ---
      if (questionId === 'step1_location') {
        timeCost = 2; stressEffect = -5
        newDialogue.push({ speaker: 'operator', text: '请问事发的确切地址是哪里？', timestamp: now })
        const nq = generateLocationNarrative(
          call.fourElements.address.partial,
          call.fourElements.address.vague,
          newStress,
        )
        newDialogue.push({ speaker: 'caller', text: nq.text, timestamp: now })
        newAddress = nq.quality === 'clear' ? 'partial' : 'vague'
        newInfoQuality['address'] = nq.quality
        // 自动填写调度卡：事件地址
        newTerminal = { ...newTerminal, address: call.fourElements.address.partial }
      }

      // --- 步骤1b：标志建筑（补充精确地址）---
      else if (questionId === 'ask_landmark') {
        timeCost = 2; stressEffect = -3
        newDialogue.push({ speaker: 'operator', text: '旁边有什么标志性建筑或者明显的店铺吗？', timestamp: now })
        const nq = pickNarrativeAnswer(
          newStress,
          call.fourElements.address.full,
          call.fourElements.address.partial,
          call.fourElements.address.vague,
        )
        newDialogue.push({ speaker: 'caller', text: nq.text, timestamp: now })
        newAddress = nq.quality === 'clear' ? 'full' : (nq.quality === 'partial' ? 'partial' : newRevealed.address)
        newInfoQuality['address'] = nq.quality
        // 自动填写调度卡：完整地址（覆盖步骤1的部分地址）
        newTerminal = { ...newTerminal, address: call.fourElements.address.full }
      }

      // --- 步骤2：事件简述 ---
      else if (questionId === 'step2_event') {
        timeCost = 3; stressEffect = -8
        newDialogue.push({ speaker: 'operator', text: '好的，请告诉我具体发生了什么事？', timestamp: now })
        const caller = getCaller(call.callerId)
        const nq = generateEventNarrative(
          call.fourElements.condition.chiefComplaint,
          call.fourElements.condition.gender,
          newStress,
          caller.relationship,
        )
        newDialogue.push({ speaker: 'caller', text: nq.text, timestamp: now })
        newRevealed.chiefComplaint = nq.quality !== 'vague'
        newInfoQuality['chiefComplaint'] = nq.quality
        if (nq.quality !== 'vague' && call.fourElements.condition.gender !== '不详') {
          newRevealed.gender = true
          newInfoQuality['gender'] = nq.quality
        }
        // 自动填写调度卡：主诉 + 性别
        newTerminal = {
          ...newTerminal,
          chiefComplaint: call.fourElements.condition.chiefComplaint,
        }
        if (call.fourElements.condition.gender !== '不详') {
          newTerminal = { ...newTerminal, patientGender: call.fourElements.condition.gender }
        }
      }

      // --- 步骤3：患者人数 ---
      else if (questionId === 'step3_count') {
        timeCost = 2; stressEffect = -3
        newDialogue.push({ speaker: 'operator', text: '一共有几个人受伤/不适？', timestamp: now })
        const count = call.fourElements.condition.patientCount
        const countText = generateCountNarrative(count, newStress)
        newDialogue.push({ speaker: 'caller', text: countText, timestamp: now })
        newInfoQuality['patientCount'] = newStress >= 75 ? 'vague' : newStress >= 50 ? 'partial' : 'clear'
      }

      // --- 步骤4：患者年龄 ---
      else if (questionId === 'step4_age') {
        timeCost = 2; stressEffect = -4
        newDialogue.push({ speaker: 'operator', text: '患者多大年龄了？', timestamp: now })
        const age = call.fourElements.condition.age
        const ageText = generateAgeNarrative(age, newStress, call.fourElements.condition.gender)
        newDialogue.push({ speaker: 'caller', text: ageText, timestamp: now })
        newRevealed.age = newStress < 75
        newInfoQuality['age'] = newStress >= 75 ? 'vague' : newStress >= 50 ? 'partial' : 'clear'

        // 生成年龄判断卡：提取干净年龄，避免"精确45岁左右"矛盾
        const ageStripped = age.replace(/左右|约|多岁|大概|男性|女性|男|女|不详/gi, '').trim()
        const isAgePrecise = ageStripped === age
        const callerIdx = newDialogue.findIndex(d => d.speaker === 'caller')
        newJudgments.push({
          id: `judge_step4_${Date.now()}`,
          questionId: 'step4_age',
          dialogueIndex: state.dialogueLog.length + (callerIdx >= 0 ? callerIdx : 1),
          question: '来电者描述的年龄信息，你应该如何记录？',
          options: [
            { label: `精确记录：${ageStripped}`, fills: [{ field: 'patientAge', value: ageStripped }], isCorrect: isAgePrecise },
            { label: `估计记录：约${ageStripped}（来电者不确定）`, fills: [{ field: 'patientAge', value: ageStripped }, { field: 'conditionNote', value: '年龄为估计值' }], isCorrect: !isAgePrecise },
            { label: '无法确认，留空待核实', fills: [], isCorrect: false },
          ],
          chosenOptionIndex: null,
        })
      }

      // --- 步骤5：意识与呼吸（最关键评估）---
      else if (questionId === 'step5_vitals') {
        timeCost = 3; stressEffect = -10
        newDialogue.push({ speaker: 'operator', text: '患者清醒吗？他/她还有呼吸吗？', timestamp: now })
        const consciousness = call.fourElements.condition.consciousness
        const breathing = call.fourElements.condition.breathing
        const vitalsText = generateVitalsNarrative(consciousness, breathing, newStress)
        newDialogue.push({ speaker: 'caller', text: vitalsText, timestamp: now })
        newRevealed.consciousness = newStress < 75
        newRevealed.breathing = newStress < 75
        newInfoQuality['consciousness'] = newStress >= 75 ? 'vague' : newStress >= 50 ? 'partial' : 'clear'
        newInfoQuality['breathing'] = newStress >= 75 ? 'vague' : newStress >= 50 ? 'partial' : 'clear'

        // 生成意识+呼吸判断卡
        const isUnconscious = consciousness.includes('无意识') || consciousness.includes('不醒') || consciousness.includes('呼之不应') || consciousness.includes('昏迷')
        const isNotBreathing = breathing.includes('没有呼吸') || breathing.includes('无呼吸') || breathing.includes('窒息') || breathing.includes('胸口不动')
        const isBreathingAbnormal = breathing.includes('急促') || breathing.includes('喘') || breathing.includes('异常')
        const callerIdx2 = newDialogue.findIndex(d => d.speaker === 'caller')
        newJudgments.push({
          id: `judge_step5_${Date.now()}`,
          questionId: 'step5_vitals',
          dialogueIndex: state.dialogueLog.length + (callerIdx2 >= 0 ? callerIdx2 : 1),
          question: '根据来电者描述，请判断患者意识与呼吸状态：',
          options: [
            { label: '有意识+呼吸正常', fills: [{ field: 'conscious', value: true }, { field: 'breathing', value: true }], isCorrect: !isUnconscious && !isNotBreathing && !isBreathingAbnormal },
            { label: '有意识+呼吸困难/急促', fills: [{ field: 'conscious', value: true }, { field: 'breathing', value: false }, { field: 'conditionNote', value: '呼吸异常' }], isCorrect: !isUnconscious && isBreathingAbnormal },
            { label: '无意识+无呼吸/无效呼吸', fills: [{ field: 'conscious', value: false }, { field: 'breathing', value: false }], isCorrect: isUnconscious && isNotBreathing },
            { label: '无意识+有呼吸', fills: [{ field: 'conscious', value: false }, { field: 'breathing', value: true }], isCorrect: isUnconscious && !isNotBreathing },
          ],
          chosenOptionIndex: null,
        })
      }

      // --- 联系电话（补充信息，随时可问）---
      else if (questionId === 'ask_contact') {
        timeCost = 1; stressEffect = -2
        newDialogue.push({ speaker: 'operator', text: '您的联系电话是多少？我记一下。', timestamp: now })
        const contactAnswer = newStress >= 50
          ? '就是我这个手机吧...哎我现在脑子都是乱的...你打我这个号就行...这个是...等一下我看看...'
          : newStress >= 25
            ? '就我这个手机！138那个...你打过来应该看得到吧？就是现在这个号码。'
            : call.fourElements.contact
        const cq: { text: string; quality: InfoQuality; distorted: boolean } =
          newStress >= 75 ? { text: '我...我不知道...你打这个能打通吧...', quality: 'vague', distorted: true } :
          newStress >= 50 ? { text: contactAnswer, quality: 'partial', distorted: true } :
          newStress >= 25 ? { text: contactAnswer, quality: 'partial', distorted: false } :
          { text: call.fourElements.contact, quality: 'clear', distorted: false }
        newDialogue.push({ speaker: 'caller', text: cq.text, timestamp: now })
        newRevealed.contact = cq.quality !== 'vague'
        newInfoQuality['contact'] = cq.quality
        // 自动填写调度卡：联系电话
        newTerminal = { ...newTerminal, contact: call.fourElements.contact }
      }

      // --- 求助诉求（四要素之一）---
      else if (questionId === 'ask_purpose') {
        timeCost = 1; stressEffect = -2
        newDialogue.push({ speaker: 'operator', text: '请明确告诉我，您现在最需要我们提供什么帮助？', timestamp: now })
        newDialogue.push({ speaker: 'caller', text: call.fourElements.purpose, timestamp: now })
        newRevealed.purpose = true
        newInfoQuality['purpose'] = newStress >= 75 ? 'partial' : 'clear'
      }

      // --- MPDS 标准问询 ---
      else {
        const mpdsQ = call.mpdsQuestions.find(q => q.id === questionId)
        if (!mpdsQ) return state

        timeCost = mpdsQ.timeCost
        stressEffect = mpdsQ.stressEffect

        newDialogue.push({ speaker: 'operator', text: mpdsQ.questionText, timestamp: now })

        // 使用叙述式回答，基于情绪选择版本
        const nq = pickNarrativeAnswer(newStress, mpdsQ.answer, mpdsQ.ramblingAnswer, mpdsQ.panickedAnswer)
        newDialogue.push({ speaker: 'caller', text: nq.text, timestamp: now })

        // 为每个揭示的字段标记信息质量（仅用于评分计算，不展示给玩家）
        for (const field of mpdsQ.reveals) {
          newInfoQuality[field] = nq.quality
          if (field === 'consciousness') {
            newRevealed.consciousness = nq.quality !== 'vague'
          } else if (field === 'breathing') {
            newRevealed.breathing = nq.quality !== 'vague'
          } else if (field === 'age') {
            newRevealed.age = nq.quality !== 'vague'
          } else if (field === 'gender') {
            newRevealed.gender = nq.quality !== 'vague'
          } else if (field === 'chiefComplaint') {
            newRevealed.chiefComplaint = nq.quality !== 'vague'
          } else if (field === 'additional') {
            const allAdditional = call.fourElements.condition.additional
            for (let i = 0; i < allAdditional.length; i++) {
              if (!newRevealed.additional.includes(allAdditional[i])) {
                newRevealed.additional = [...newRevealed.additional, allAdditional[i]]
                newInfoQuality[`additional_${i}`] = nq.quality
                break
              }
            }
          }
        }

        // 若该问询定义了临床判断选择题，为来电者回答生成判断卡
        if (mpdsQ.judgment) {
          const callerIdx = newDialogue.findIndex(d => d.speaker === 'caller')
          newJudgments.push({
            id: `judge_${questionId}_${Date.now()}`,
            questionId,
            dialogueIndex: state.dialogueLog.length + (callerIdx >= 0 ? callerIdx : 1),
            question: mpdsQ.judgment.question,
            options: mpdsQ.judgment.options,
            chosenOptionIndex: null,
          })
        }
      }

      // --- 统一收尾 ---
      newAskedMPDS.push(questionId)

      const questionPenalty = Math.max(0, cs.questionCount - 4) * 3
      newStress = Math.max(0, Math.min(100, newStress + stressEffect + questionPenalty))
      const newStressLevel = stressToLevel(newStress)

      // 情绪爆发
      if (cs.stressLevel !== 'hysterical' && newStressLevel === 'hysterical') {
        newDialogue.push({
          speaker: 'caller', text: '我...我真的不行了！你们到底能不能来？！', timestamp: now,
        })
      } else if (cs.stressLevel === 'calm' && newStressLevel === 'panicked') {
        newDialogue.push({
          speaker: 'caller', text: '你能不能快点……我感觉越来越不好了……', timestamp: now,
        })
      }

      const updatedRevealed = { ...newRevealed, address: newAddress }

      for (const evt of call.specialEvents) {
        const matchesQuestion = !evt.triggerValue || evt.triggerValue === questionId
        const alreadyInserted = state.dialogueLog.some(line => line.text === evt.dialogue)
          || newDialogue.some(line => line.text === evt.dialogue)
        if (evt.trigger === 'after_question' && matchesQuestion && !alreadyInserted) {
          newDialogue.push({
            speaker: 'caller',
            text: evt.dialogue,
            timestamp: now + timeCost,
          })
        }
      }

      return {
        ...state,
        callPhase: 'questioning',
        shiftElapsed: state.shiftElapsed + timeCost,
        questionCost: state.questionCost + timeCost,
        pendingJudgments: newJudgments,
        terminal: newTerminal,
        callerState: {
          ...cs,
          revealedInfo: updatedRevealed,
          infoQuality: newInfoQuality,
          askedMPDS: newAskedMPDS,
          stress: newStress,
          stressLevel: newStressLevel,
          questionCount: cs.questionCount + 1,
        },
        dialogueLog: [...state.dialogueLog, ...newDialogue],
      }
    }

    // ==========================================
    // CALM_CALLER — 安抚来电者情绪（消耗时间但提高答案质量）
    // ==========================================
    case 'CALM_CALLER': {
      if (!state.currentCall || !state.callerState) return state
      if (state.callPhase !== 'questioning' && state.callPhase !== 'connected') return state

      const cs = state.callerState
      const now = state.shiftElapsed
      const stressDrop = 20 + Math.floor(Math.random() * 10)  // 降低20-30点压力
      const newStress = Math.max(0, cs.stress - stressDrop)
      const newStressLevel = stressToLevel(newStress)

      const calmPhrases = [
        '请您深呼吸，慢慢说。救护车启动需要您提供准确信息。',
        '我理解您很着急，但请您尽量保持冷静，我需要您的帮助。',
        '别担心，我会一直在这个电话上。请您配合我，我们一步步来。',
        '您做得很好，请继续保持。现在我需要再确认几个信息。',
      ]
      const phrase = calmPhrases[Math.floor(Math.random() * calmPhrases.length)]

      const opLine: DialogueLine = { speaker: 'operator', text: phrase, timestamp: now }
      const callerLine: DialogueLine = {
        speaker: 'caller', text: '好...好的，我尽量...你说...',
        timestamp: now,
      }

      return {
        ...state,
        shiftElapsed: state.shiftElapsed + 2,
        questionCost: state.questionCost + 2,   // 安抚消耗2秒
        callerState: {
          ...cs,
          stress: newStress,
          stressLevel: newStressLevel,
        },
        dialogueLog: [...state.dialogueLog, opLine, callerLine],
      }
    }

    // ==========================================
    // UPDATE_TERMINAL — 更新终端登记
    // ==========================================
    case 'UPDATE_TERMINAL': {
      return {
        ...state,
        terminal: {
          ...state.terminal,
          [action.field]: action.value,
        },
      }
    }

    // ==========================================
    // SET_PATIENT_STATUS — 设置患者生命体征
    // ==========================================
    case 'SET_PATIENT_STATUS': {
      return {
        ...state,
        terminal: {
          ...state.terminal,
          [action.field]: action.value,
        },
      }
    }

    // ==========================================
    // SET_MPDS_DETERMINANT — 设置MPDS判定码
    // ==========================================
    case 'SET_MPDS_DETERMINANT': {
      return {
        ...state,
        terminal: {
          ...state.terminal,
          determinant: action.determinant,
          hotCold: action.determinant === 'ECHO' || action.determinant === 'DELTA'
            ? 'HOT'
            : 'COLD',
        },
      }
    }

    // ==========================================
    // SET_TRIAGE — 设置分诊等级
    // ==========================================
    case 'SET_TRIAGE': {
      return {
        ...state,
        terminal: {
          ...state.terminal,
          triage: action.level,
        },
      }
    }

    // ==========================================
    // MAKE_JUDGMENT — 玩家从临床判断选择题中选择答案
    // ==========================================
    case 'MAKE_JUDGMENT': {
      const { judgmentId, chosenOptionIndex } = action
      const idx = state.pendingJudgments.findIndex(j => j.id === judgmentId)
      if (idx < 0) return state

      const updatedJudgment = { ...state.pendingJudgments[idx], chosenOptionIndex }
      const newJudgments = [...state.pendingJudgments]
      newJudgments[idx] = updatedJudgment

      // 应用判断选择的终端填充
      const selectedOption = updatedJudgment.options[chosenOptionIndex]
      let newTerminal = { ...state.terminal }
      if (selectedOption) {
        for (const fill of selectedOption.fills) {
          if (fill.field === 'conscious') {
            newTerminal = { ...newTerminal, conscious: fill.value as boolean }
          } else if (fill.field === 'breathing') {
            newTerminal = { ...newTerminal, breathing: fill.value as boolean }
          } else {
            newTerminal = { ...newTerminal, [fill.field]: fill.value }
          }
        }
      }

      return {
        ...state,
        pendingJudgments: newJudgments,
        terminal: newTerminal,
      }
    }

    // ==========================================
    // DISPATCH — 派出救护车
    // ==========================================
    case 'DISPATCH': {
      if (!state.currentCall || !state.callerState) return state
      if (state.dispatchSent) return state
      if (!state.terminal.determinant || !state.terminal.triage) return state

      const dispatchTime = state.shiftElapsed - state.callStartTime
      const rawAddress = state.callerState.revealedInfo.address
      const addressCompleteness: 'vague' | 'partial' | 'full' =
        rawAddress === 'none' ? 'vague' : rawAddress

      // 如果没选分诊，默认用场景预设
      const triage = state.terminal.triage

      const eta = calcAmbulanceETA(dispatchTime, addressCompleteness)

      const systemLine: DialogueLine = {
        speaker: 'system',
        text: `【🚑 救护车已派出 — 分诊等级: ${triage === 'red' ? '红色(濒危)' : triage === 'yellow' ? '黄色(危重)' : triage === 'green' ? '绿色(轻伤)' : '黑色'} | 预计到达: ${eta}秒 | 派车耗时: ${dispatchTime}秒】`,
        timestamp: state.shiftElapsed,
      }

      const dispatchEventLines: DialogueLine[] = state.currentCall.specialEvents
        .filter(evt => evt.trigger === 'after_dispatch')
        .filter(evt => !state.dialogueLog.some(line => line.text === evt.dialogue))
        .map(evt => ({
          speaker: 'caller' as const,
          text: evt.dialogue,
          timestamp: state.shiftElapsed,
        }))

      const record = {
        callId: state.currentCall.id,
        dispatchTime,
        triage,
        addressCompleteness,
        ambulanceETA: eta,
      }

      // 检查是否需要进入急救指导阶段
      const hasGuidance = state.currentCall.guidance !== null

      return {
        ...state,
        dispatchSent: true,
        dispatchRecord: record,
        ambulanceRemaining: eta,
        callPhase: hasGuidance ? 'guidance' : 'closing',
        guidanceActive: hasGuidance,
        guidanceStepIndex: 0,
        guidanceResults: hasGuidance
          ? new Array(state.currentCall.guidance!.steps.length).fill(null)
          : [],
        dialogueLog: [...state.dialogueLog, systemLine, ...dispatchEventLines],
      }
    }

    // ==========================================
    // ANSWER_GUIDANCE — 回答急救指导（记录结果，直接推进下一步）
    // ==========================================
    case 'ANSWER_GUIDANCE': {
      if (!state.currentCall?.guidance) return state
      if (!state.guidanceActive) return state
      if (state.callPhase !== 'guidance') return state

      const guidanceDef = state.currentCall.guidance
      const step = guidanceDef.steps[action.stepIndex]
      if (!step) return state

      const isCorrect = action.selectedIndex === step.correctIndex
      const now = state.shiftElapsed

      const callerText = isCorrect ? step.feedback.callerCorrect : step.feedback.callerIncorrect

      const operatorLine: DialogueLine = {
        speaker: 'operator',
        text: step.instruction,
        timestamp: now,
      }
      const feedbackLine: DialogueLine = {
        speaker: 'caller',
        text: callerText,
        timestamp: now,
      }

      const newResults = [...state.guidanceResults]
      newResults[action.stepIndex] = isCorrect ? 'correct' : 'incorrect'

      const nextIndex = action.stepIndex + 1
      const isLastStep = nextIndex >= guidanceDef.steps.length

      return {
        ...state,
        guidanceStepIndex: nextIndex,
        guidanceResults: newResults,
        callPhase: isLastStep ? 'closing' : 'guidance',
        dialogueLog: [...state.dialogueLog, operatorLine, feedbackLine],
      }
    }

    // ==========================================
    // END_CALL — 结束当前通话
    // ==========================================
    case 'END_CALL': {
      if (!state.currentCall || !state.callerState) return state

      const call = state.currentCall
      const cs = state.callerState
      const dispatchRecord = state.dispatchRecord
      const didDispatch = dispatchRecord !== null

      // 计算本通电话得分
      let total: number
      let speed = 0
      let info = 0
      let triageScore = 0
      let guidanceScore = 0
      let decisionPenalty = 0

      // 恶作剧电话特殊评分
      if (call.isPrank) {
        if (!didDispatch) {
          const correctlyIdentified = state.pendingJudgments.some(judgment => {
            const selected = judgment.chosenOptionIndex
            return judgment.questionId === 'mpds_prank_patient'
              && selected !== null
              && judgment.options[selected]?.isCorrect === true
          })
          if (correctlyIdentified) {
            // 完成核实并正确识别恶作剧。
            total = 100
            speed = 40
            info = 30
            triageScore = 20
            guidanceScore = 10
          } else {
            // 未核实便挂断，避免玩家在接通后立即挂断刷满分。
            total = 40
            speed = 20
            info = 10
            triageScore = 10
            guidanceScore = 0
            decisionPenalty = 60
          }
        } else {
          // 错误派车 → 0分
          total = 0
          speed = 0
          info = 0
          triageScore = 0
          guidanceScore = 0
          decisionPenalty = 100
        }
      } else {
        // 统计信息质量加分
        const qualityCount = Object.values(cs.infoQuality)
        const clearCount = qualityCount.filter(q => q === 'clear').length
        const qualityBonus = Math.min(5, clearCount)

        const result = scoreCall(
          dispatchRecord?.dispatchTime ?? null,
          dispatchRecord?.addressCompleteness ?? 'vague',
          cs.revealedInfo.contact,
          cs.revealedInfo.chiefComplaint,
          cs.revealedInfo.purpose,
          dispatchRecord?.triage ?? null,
          call.correctTriage,
          state.guidanceResults.filter(r => r === 'correct').length,
          state.guidanceResults.length,
          qualityBonus,
        )
        decisionPenalty = calculateDecisionPenalty(
          state.pendingJudgments,
          determinantFromCode(call.mpdsCard.determinantCode),
          state.terminal.determinant,
          expectedVital(call, 'conscious'),
          state.terminal.conscious,
          expectedVital(call, 'breathing'),
          state.terminal.breathing,
        )
        total = Math.max(0, result.total - decisionPenalty)
        speed = result.speed
        info = result.info
        triageScore = result.triage
        guidanceScore = result.guidance
      }

      const nextCallIndex = state.callIndex + 1
      const isShiftOver = nextCallIndex >= state.totalCalls

      // 通话结束的总结行
      const summaryLine: DialogueLine = {
        speaker: 'system',
        text: `【通话结束 | 得分: ${total}/100 — 派车速度:${speed} 信息:${info} 分诊:${triageScore} 指导:${guidanceScore} 判断扣分:${decisionPenalty}】`,
        timestamp: state.shiftElapsed,
      }

      return {
        ...state,
        callIndex: nextCallIndex,
        callPhase: 'completed',
        currentCall: null,
        callerState: null,
        dispatchSent: false,
        dispatchRecord: null,
        ambulanceRemaining: -1,
        guidanceActive: false,
        totalScore: state.totalScore + total,
        callScores: [...state.callScores, total],
        dialogueLog: [...state.dialogueLog, summaryLine],
        screen: isShiftOver ? 'ending' : 'playing',
      }
    }

    // ==========================================
    // TICK — 时钟滴答（每秒）
    // ==========================================
    case 'TICK': {
      if (state.screen !== 'playing') return state

      const newElapsed = state.shiftElapsed + 1
      let newAmbulanceRemaining = state.ambulanceRemaining
      const newDialogue: DialogueLine[] = []

      // 救护车倒计时
      if (state.dispatchSent && state.ambulanceRemaining > 0) {
        newAmbulanceRemaining -= 1
        if (newAmbulanceRemaining === 0) {
          newDialogue.push({
            speaker: 'system',
            text: '【🚑 救护车已到达现场】',
            timestamp: newElapsed,
          })
        }
      }

      // 检查时间触发的事件
      if (state.currentCall && state.callerState) {
        for (const evt of state.currentCall.specialEvents) {
          if (evt.trigger === 'time_elapsed' && evt.triggerValue) {
            const triggerSec = parseInt(evt.triggerValue, 10)
            const callTime = newElapsed - state.callStartTime
            // 游戏内问询会推进数秒；使用 >= 避免跨过触发时刻后漏掉事件。
            if (callTime >= triggerSec) {
              // 检查是否已经插入过这个事件
              const alreadyInserted = state.dialogueLog.some(
                l => l.text === evt.dialogue
              )
              if (!alreadyInserted) {
                newDialogue.push({
                  speaker: 'caller',
                  text: evt.dialogue,
                  timestamp: newElapsed,
                })
              }
            }
          }
        }
      }

      return {
        ...state,
        shiftElapsed: newElapsed,
        ambulanceRemaining: newAmbulanceRemaining,
        dialogueLog: state.dialogueLog.length > 0 || newDialogue.length > 0
          ? [...state.dialogueLog, ...newDialogue]
          : state.dialogueLog,
      }
    }

    // ==========================================
    // SHOW_ENDING — 显示结局
    // ==========================================
    case 'SHOW_ENDING': {
      return { ...state, screen: 'ending' }
    }

    // ==========================================
    // BACK_TO_TITLE — 返回标题
    // ==========================================
    case 'BACK_TO_TITLE': {
      return createInitialState()
    }

    default:
      return state
  }
}

export type { GameAction }
