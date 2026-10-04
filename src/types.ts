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
  /** 旧稿升级时查回的原出版版本 */
  legacy?: boolean
}

/** 声部长离线校订时对评论锚点的改动 */
export interface CommentUpdate {
  id: string
  resolved?: boolean
  content?: string
}

export type SubmissionStatus = 'returned' | 'merged' | 'rejected'

/** 声部长回传的一册离线校订（已交声部，写盘失败时据此恢复） */
export interface PartSubmission {
  id: string
  trackId: string
  trackName: string
  author: string
  submittedAt: string
  baseVersionId: string
  /** 带回离线校订时的总谱基线修订号 */
  baseRevision: number
  baselineTransposition: number
  baselineNotes: ScoreNote[]
  baselineComments: ScoreComment[]
  notes: ScoreNote[]
  commentUpdates: CommentUpdate[]
  status: SubmissionStatus
}

/** 冲突处置选择：保留现行总谱内容 / 采用回传内容 */
export type ConflictChoice = 'master' | 'theirs'
