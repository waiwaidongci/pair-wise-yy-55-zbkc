export interface ScoreNote {
  id: string
  key: string
  duration: 'q' | 'h' | '8'
  accidental?: '#' | 'b' | 'n'
  dynamic: 'pp' | 'p' | 'mp' | 'mf' | 'f' | 'ff'
  tie: boolean
  expression: string
}

export interface Track {
  id: string
  name: string
  instrument: string
  clef: 'treble' | 'bass' | 'alto'
  transposition: number
  color: string
  notes: ScoreNote[]
}

export interface ScoreComment {
  id: string
  measure: number
  author: string
  content: string
  resolved: boolean
}

export interface ScoreVersion {
  id: string
  author: string
  time: string
  summary: string
  trackNotes: Record<string, ScoreNote[]>
}

// 分谱回传（声部长离线校订后交回的一册）
export interface PartSubmission {
  id: string
  token: string                 // 幂等键：重试写盘不重复追加
  partId: string
  partName: string
  author: string                // 两位声部长之一
  baseVersionId: string         // 离线时所依据的基线版本
  submittedAt: string
  baseNotes: ScoreNote[]        // 离线时该声部的音符（三方合并 base）
  baseComments: ScoreComment[]  // 离线时的评论锚点
  notes: ScoreNote[]            // 回传的修订音符
  comments: ScoreComment[]      // 回传的评论锚点修订
  status: 'candidate' | 'conflict' | 'merged'
  writeStatus: 'writing' | 'failed' | 'written'
  attempts: number
}

// 合并候选：某声部当前可并入的一册（先到者）
export interface MergeCandidate {
  id: string
  partId: string
  submissionId: string
  baselineVersionId: string     // 计算时所依据的基线，基线一变即失效
  status: 'active' | 'invalidated' | 'merged'
  cleanNoteIds: string[]        // 单边修改、可直接并入的音符标识
  cleanCommentIds: string[]     // 单边修改、可直接并入的评论锚点
  conflictIds: string[]
}

// 待处置冲突：两边都改过，保留双方内容
export interface PendingConflict {
  id: string
  partId: string
  submissionId: string
  kind: 'note' | 'comment'
  targetId: string              // 音符标识或评论锚点 id
  anchorLabel: string           // 展示用锚点（第 X 小节 / 音符 N-x）
  base: unknown
  ours: unknown                 // 总谱侧内容
  theirs: unknown               // 回传侧内容
  status: 'pending' | 'ours' | 'theirs'
}

// 旧稿（没有声部标识，升级后存档仍可查回）
export interface LegacyDraftTrack {
  name: string
  instrument: string
  notes: { key: string; duration: string }[]
}

export interface LegacyDraft {
  app: string
  schema: number
  savedAt: string
  tracks: LegacyDraftTrack[]
  comments: ScoreComment[]
}

// 换页提示：由分谱音符派生，随基线失效并重算
export interface PageTurnHint {
  id: string
  partId: string
  measure: number
  reason: string
  baselineVersionId: string
  valid: boolean
}
