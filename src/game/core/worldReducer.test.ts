import { describe, expect, it } from 'vitest'
import type { JudgmentPrompt, WorldState } from '../types'
import { createInitialState } from './worldState'
import { worldReducer } from './worldReducer'

function beginCall(scenarioId = 'cardiac_arrest'): WorldState {
  const started = worldReducer(createInitialState(), { type: 'START_SHIFT' })
  const withScenario = {
    ...started,
    scenarioQueue: [scenarioId, ...started.scenarioQueue.filter(id => id !== scenarioId)],
  }
  return worldReducer(withScenario, { type: 'ANSWER_CALL' })
}

describe('worldReducer', () => {
  it('advances game time for questions and records the caller purpose', () => {
    const answered = beginCall()
    const afterLocation = worldReducer(answered, {
      type: 'ASK_QUESTION',
      questionId: 'step1_location',
    })
    const afterPurpose = worldReducer(afterLocation, {
      type: 'ASK_QUESTION',
      questionId: 'ask_purpose',
    })

    expect(afterLocation.shiftElapsed).toBe(answered.shiftElapsed + 2)
    expect(afterPurpose.shiftElapsed).toBe(answered.shiftElapsed + 3)
    expect(afterPurpose.questionCost).toBe(3)
    expect(afterPurpose.callerState?.revealedInfo.purpose).toBe(true)
  })

  it('keeps MPDS determinant and triage independent and emits after-dispatch events', () => {
    const answered = beginCall()
    const classified = worldReducer(answered, {
      type: 'SET_MPDS_DETERMINANT',
      determinant: 'ECHO',
    })
    const blocked = worldReducer(classified, { type: 'DISPATCH' })
    const triaged = worldReducer(classified, { type: 'SET_TRIAGE', level: 'red' })
    const dispatched = worldReducer(triaged, { type: 'DISPATCH' })

    expect(classified.terminal.triage).toBeNull()
    expect(answered.terminal.hotCold).toBeNull()
    expect(classified.terminal.hotCold).toBe('HOT')
    expect(blocked.dispatchRecord).toBeNull()
    expect(dispatched.dispatchRecord?.triage).toBe('red')
    expect(dispatched.dialogueLog).toHaveLength(triaged.dialogueLog.length + 2)
  })

  it('derives HOT or COLD response mode from the player determinant', () => {
    const answered = beginCall()
    const alpha = worldReducer(answered, {
      type: 'SET_MPDS_DETERMINANT',
      determinant: 'ALPHA',
    })

    expect(alpha.terminal.hotCold).toBe('COLD')
  })

  it('deducts points for an incorrect MPDS determinant', () => {
    const answered = beginCall()

    const correctClassified = worldReducer(answered, {
      type: 'SET_MPDS_DETERMINANT',
      determinant: 'ECHO',
    })
    const correctTriaged = worldReducer(correctClassified, {
      type: 'SET_TRIAGE',
      level: 'red',
    })
    const correctEnded = worldReducer(
      worldReducer(correctTriaged, { type: 'DISPATCH' }),
      { type: 'END_CALL' },
    )

    const wrongDeterminant = worldReducer(answered, {
      type: 'SET_MPDS_DETERMINANT',
      determinant: 'ALPHA',
    })
    const correctedTriage = worldReducer(wrongDeterminant, {
      type: 'SET_TRIAGE',
      level: 'red',
    })
    const wrongEnded = worldReducer(
      worldReducer(correctedTriage, { type: 'DISPATCH' }),
      { type: 'END_CALL' },
    )

    expect(correctEnded.callScores[0] - wrongEnded.callScores[0]).toBe(5)
  })

  it('deducts points for an incorrect clinical judgment', () => {
    const classified = worldReducer(beginCall(), {
      type: 'SET_MPDS_DETERMINANT',
      determinant: 'ECHO',
    })
    const triaged = worldReducer(classified, { type: 'SET_TRIAGE', level: 'red' })
    const judgment: JudgmentPrompt = {
      id: 'test-judgment',
      questionId: 'test-question',
      dialogueIndex: 0,
      question: '测试临床判断',
      options: [
        { label: '正确', fills: [], isCorrect: true },
        { label: '错误', fills: [], isCorrect: false },
      ],
      chosenOptionIndex: 0,
    }

    const correctEnded = worldReducer(
      worldReducer({ ...triaged, pendingJudgments: [judgment] }, { type: 'DISPATCH' }),
      { type: 'END_CALL' },
    )
    const wrongEnded = worldReducer(
      worldReducer({
        ...triaged,
        pendingJudgments: [{ ...judgment, chosenOptionIndex: 1 }],
      }, { type: 'DISPATCH' }),
      { type: 'END_CALL' },
    )

    expect(correctEnded.callScores[0] - wrongEnded.callScores[0]).toBe(5)
  })

  it('does not award a perfect prank score before the caller is verified', () => {
    const prankCall = beginCall('prank_call')
    const unverifiedEnd = worldReducer(prankCall, { type: 'END_CALL' })

    const questioned = worldReducer(prankCall, {
      type: 'ASK_QUESTION',
      questionId: 'mpds_prank_patient',
    })
    const judgment = questioned.pendingJudgments[0]
    expect(judgment).toBeDefined()

    const verified = worldReducer(questioned, {
      type: 'MAKE_JUDGMENT',
      judgmentId: judgment.id,
      chosenOptionIndex: 1,
    })
    const verifiedEnd = worldReducer(verified, { type: 'END_CALL' })

    expect(unverifiedEnd.callScores[0]).toBe(40)
    expect(verifiedEnd.callScores[0]).toBe(100)
  })

  it('does not accept an unrelated correct judgment as prank verification', () => {
    const prankCall = beginCall('prank_call')
    const unrelated: JudgmentPrompt = {
      id: 'age-judgment',
      questionId: 'step4_age',
      dialogueIndex: 0,
      question: '记录年龄',
      options: [{ label: '正确年龄', fills: [], isCorrect: true }],
      chosenOptionIndex: 0,
    }

    const ended = worldReducer(
      { ...prankCall, pendingJudgments: [unrelated] },
      { type: 'END_CALL' },
    )

    expect(ended.callScores[0]).toBe(40)
  })

  it('deducts points when final vital signs are recorded incorrectly', () => {
    const classified = worldReducer(beginCall(), {
      type: 'SET_MPDS_DETERMINANT',
      determinant: 'ECHO',
    })
    const triaged = worldReducer(classified, { type: 'SET_TRIAGE', level: 'red' })
    const correctVitals = worldReducer(
      worldReducer(triaged, { type: 'SET_PATIENT_STATUS', field: 'conscious', value: false }),
      { type: 'SET_PATIENT_STATUS', field: 'breathing', value: false },
    )
    const wrongVitals = worldReducer(
      worldReducer(triaged, { type: 'SET_PATIENT_STATUS', field: 'conscious', value: true }),
      { type: 'SET_PATIENT_STATUS', field: 'breathing', value: true },
    )

    const correctEnded = worldReducer(
      worldReducer(correctVitals, { type: 'DISPATCH' }),
      { type: 'END_CALL' },
    )
    const wrongEnded = worldReducer(
      worldReducer(wrongVitals, { type: 'DISPATCH' }),
      { type: 'END_CALL' },
    )

    expect(correctEnded.callScores[0] - wrongEnded.callScores[0]).toBe(6)
  })
})
