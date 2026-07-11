// ============================================================
// 零点接线台 — Game Actions
// ============================================================

import type { TriageLevel, MpdsDeterminant, FragmentTargetField } from '../types'

export type TerminalField = 'address' | 'contact' | 'chiefComplaint' | 'patientAge' | 'patientGender' | 'conditionNote'

export type GameAction =
  | { type: 'START_SHIFT' }
  | { type: 'ANSWER_CALL' }
  | { type: 'ASK_QUESTION'; questionId: string }
  | { type: 'CALM_CALLER' }                                          // 安抚来电者情绪
  | { type: 'MAKE_JUDGMENT'; judgmentId: string; chosenOptionIndex: number }  // 临床判断选择题
  | { type: 'UPDATE_TERMINAL'; field: TerminalField | FragmentTargetField; value: string }
  | { type: 'SET_PATIENT_STATUS'; field: 'conscious' | 'breathing'; value: boolean }
  | { type: 'SET_MPDS_DETERMINANT'; determinant: MpdsDeterminant }
  | { type: 'SET_TRIAGE'; level: TriageLevel }
  | { type: 'DISPATCH' }
  | { type: 'ANSWER_GUIDANCE'; stepIndex: number; selectedIndex: number }
  | { type: 'END_CALL' }
  | { type: 'TICK' }
  | { type: 'SHOW_ENDING' }
  | { type: 'BACK_TO_TITLE' }
