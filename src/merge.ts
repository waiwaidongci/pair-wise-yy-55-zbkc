import type { CommentUpdate, ConflictChoice, PartSubmission, ScoreComment, ScoreNote, Track } from './types'

export interface NoteChange {
  noteId: string
  kind: 'added' | 'modified' | 'removed'
  before: ScoreNote | null
  after: ScoreNote | null
}

/** 两边都改过的音符：双方内容都保留，等待处置 */
export interface NoteConflict {
  noteId: string
  baseline: ScoreNote | null
  master: ScoreNote | null
  submitted: ScoreNote | null
}

export interface CommentChange {
  commentId: string
  anchor: number
  before: ScoreComment
  after: ScoreComment
}

export interface CommentConflict {
  commentId: string
  anchor: number
  master: ScoreComment | null
  submitted: ScoreComment
}

export interface PageTurnHint {
  id: string
  afterMeasure: number
  cueMeasures: number
  pendingReview: boolean
  note: string
}

export interface MergeResult {
  notes: ScoreNote[]
  noteChanges: NoteChange[]
  noteConflicts: NoteConflict[]
  comments: ScoreComment[]
  commentChanges: CommentChange[]
  commentConflicts: CommentConflict[]
  pageTurnHints: PageTurnHint[]
}

export const NOTES_PER_MEASURE = 4
const PAGE_MEASURES = 2

export function notesEqual(a: ScoreNote, b: ScoreNote): boolean {
  return a.key === b.key && a.duration === b.duration && (a.accidental ?? '') === (b.accidental ?? '') && a.dynamic === b.dynamic && a.tie === b.tie && a.expression === b.expression
}

function commentsEqual(a: ScoreComment, b: ScoreComment): boolean {
  return a.measure === b.measure && a.content === b.content && a.resolved === b.resolved
}

function pickDefined(update: CommentUpdate): Partial<ScoreComment> {
  const patch: Partial<ScoreComment> = {}
  if (update.resolved !== undefined) patch.resolved = update.resolved
  if (update.content !== undefined) patch.content = update.content
  return patch
}

/**
 * 三方合并：以声部长带回时的基线为参照，按音符标识逐项比较。
 * 只有一边改过 → 直接并入；两边都改过且不一致 → 双方内容都保留为冲突。
 */
export function mergeTrackNotes(
  baseline: ScoreNote[],
  master: ScoreNote[],
  submitted: ScoreNote[],
  resolutions: Record<string, ConflictChoice>,
): { notes: ScoreNote[]; changes: NoteChange[]; conflicts: NoteConflict[] } {
  const baseById = new Map(baseline.map((note) => [note.id, note]))
  const subById = new Map(submitted.map((note) => [note.id, note]))
  const changes: NoteChange[] = []
  const conflicts: NoteConflict[] = []
  const notes: ScoreNote[] = []
  const emitted = new Set<string>()

  for (const current of master) {
    const base = baseById.get(current.id)
    const theirs = subById.get(current.id)
    if (!base) {
      // 现行总谱在声部长带回后新增的音符
      if (theirs && !notesEqual(current, theirs)) {
        conflicts.push({ noteId: current.id, baseline: null, master: structuredClone(current), submitted: structuredClone(theirs) })
        notes.push(structuredClone(resolutions[current.id] === 'theirs' ? theirs : current))
      } else {
        notes.push(structuredClone(current))
      }
      emitted.add(current.id)
      continue
    }
    const masterChanged = !notesEqual(base, current)
    if (!theirs) {
      // 回传中删除了该音
      if (!masterChanged) {
        changes.push({ noteId: current.id, kind: 'removed', before: structuredClone(base), after: null })
      } else {
        conflicts.push({ noteId: current.id, baseline: structuredClone(base), master: structuredClone(current), submitted: null })
        if (resolutions[current.id] !== 'theirs') notes.push(structuredClone(current))
      }
      emitted.add(current.id)
      continue
    }
    const submittedChanged = !notesEqual(base, theirs)
    if (!masterChanged && !submittedChanged) {
      notes.push(structuredClone(current))
    } else if (!masterChanged) {
      // 单边修改（回传）→ 直接并入
      notes.push(structuredClone(theirs))
      changes.push({ noteId: current.id, kind: 'modified', before: structuredClone(base), after: structuredClone(theirs) })
    } else if (!submittedChanged || notesEqual(current, theirs)) {
      // 单边修改（总谱）或两边改成了一样 → 维持现行内容
      notes.push(structuredClone(current))
    } else {
      conflicts.push({ noteId: current.id, baseline: structuredClone(base), master: structuredClone(current), submitted: structuredClone(theirs) })
      notes.push(structuredClone(resolutions[current.id] === 'theirs' ? theirs : current))
    }
    emitted.add(current.id)
  }

  for (const theirs of submitted) {
    if (emitted.has(theirs.id)) continue
    const base = baseById.get(theirs.id)
    if (!base) {
      // 回传新增的音符 → 直接并入
      notes.push(structuredClone(theirs))
      changes.push({ noteId: theirs.id, kind: 'added', before: null, after: structuredClone(theirs) })
      emitted.add(theirs.id)
    } else if (!notesEqual(base, theirs)) {
      // 现行总谱已删除、回传却改过的音符 → 冲突，双方内容都保留
      conflicts.push({ noteId: theirs.id, baseline: structuredClone(base), master: null, submitted: structuredClone(theirs) })
      if (resolutions[theirs.id] === 'theirs') notes.push(structuredClone(theirs))
      emitted.add(theirs.id)
    }
  }
  return { notes, changes, conflicts }
}

/** 按评论锚点（评论标识 + 小节）合并声部长带回的评论改动 */
export function mergeComments(
  baseline: ScoreComment[],
  master: ScoreComment[],
  updates: CommentUpdate[],
  resolutions: Record<string, ConflictChoice>,
): { comments: ScoreComment[]; changes: CommentChange[]; conflicts: CommentConflict[] } {
  const changes: CommentChange[] = []
  const conflicts: CommentConflict[] = []
  const comments = master.map((comment) => structuredClone(comment))
  for (const update of updates) {
    const base = baseline.find((comment) => comment.id === update.id)
    const current = comments.find((comment) => comment.id === update.id)
    const fallback: ScoreComment = base ?? current ?? { id: update.id, measure: 0, author: '', content: '', resolved: false }
    const submitted: ScoreComment = { ...fallback, ...pickDefined(update) }
    if (!current) {
      conflicts.push({ commentId: update.id, anchor: base?.measure ?? 0, master: null, submitted })
      continue
    }
    const masterChanged = !base || !commentsEqual(base, current)
    const submittedChanged = !base || !commentsEqual(base, submitted)
    if (!submittedChanged || commentsEqual(current, submitted)) continue
    if (!masterChanged) {
      Object.assign(current, pickDefined(update))
      changes.push({ commentId: current.id, anchor: current.measure, before: structuredClone(base!), after: structuredClone(current) })
    } else {
      conflicts.push({ commentId: current.id, anchor: current.measure, master: structuredClone(current), submitted })
      if (resolutions[`c:${current.id}`] === 'theirs') Object.assign(current, pickDefined(update))
    }
  }
  return { comments, changes, conflicts }
}

/** 换页提示由合并结果推导：音符、移调或评论一变即按新基线重算 */
export function computePageTurnHints(trackId: string, notes: ScoreNote[], comments: ScoreComment[]): PageTurnHint[] {
  const measures = Math.max(1, Math.ceil(notes.length / NOTES_PER_MEASURE))
  const cueRule = comments.find((comment) => comment.content.includes('换页') && comment.content.includes('提示'))
  const confirmedCue = cueRule?.resolved ? 2 : 1
  const pendingReview = comments.some((comment) => !comment.resolved && comment.content.includes('换页'))
  const hints: PageTurnHint[] = []
  for (let measure = PAGE_MEASURES; measure < measures; measure += PAGE_MEASURES) {
    const boundary = notes[measure * NOTES_PER_MEASURE - 1]
    const cueMeasures = boundary?.tie ? 2 : confirmedCue
    hints.push({
      id: `PT-${trackId}-${measure}`,
      afterMeasure: measure,
      cueMeasures,
      pendingReview,
      note: boundary?.tie ? '边界含延音线，提示音延长至 2 小节' : cueRule?.resolved ? '按已确认的出版要求保留提示音' : '按现行基线重算',
    })
  }
  return hints
}

/** 以现行总谱为新基线，实时重算一册回传的出版候选 */
export function computeCandidate(
  submission: PartSubmission,
  track: Track,
  masterComments: ScoreComment[],
  resolutions: Record<string, ConflictChoice>,
): MergeResult {
  const noteResolutions: Record<string, ConflictChoice> = {}
  const commentResolutions: Record<string, ConflictChoice> = {}
  for (const [key, choice] of Object.entries(resolutions)) {
    if (key.startsWith('c:')) commentResolutions[key] = choice
    else noteResolutions[key] = choice
  }
  const merged = mergeTrackNotes(submission.baselineNotes, track.notes, submission.notes, noteResolutions)
  const commentResult = mergeComments(submission.baselineComments, masterComments, submission.commentUpdates, commentResolutions)
  return {
    notes: merged.notes,
    noteChanges: merged.changes,
    noteConflicts: merged.conflicts,
    comments: commentResult.comments,
    commentChanges: commentResult.changes,
    commentConflicts: commentResult.conflicts,
    pageTurnHints: computePageTurnHints(track.id, merged.notes, commentResult.comments),
  }
}

export function describeNote(note: ScoreNote | null | undefined): string {
  if (!note) return '（已删除）'
  const parts = [note.key.replace('/', ''), note.duration === 'q' ? '四分' : note.duration === 'h' ? '二分' : '八分', note.dynamic]
  if (note.accidental) parts.push(`临时记号 ${note.accidental}`)
  if (note.tie) parts.push('延音线')
  if (note.expression) parts.push(note.expression)
  return parts.join(' · ')
}

export function diffNoteFields(before: ScoreNote, after: ScoreNote): string[] {
  const diffs: string[] = []
  if (before.key !== after.key) diffs.push(`音高 ${before.key} → ${after.key}`)
  if (before.duration !== after.duration) diffs.push(`时值 ${before.duration} → ${after.duration}`)
  if ((before.accidental ?? '') !== (after.accidental ?? '')) diffs.push(`临时记号 ${before.accidental ?? '无'} → ${after.accidental ?? '无'}`)
  if (before.dynamic !== after.dynamic) diffs.push(`力度 ${before.dynamic} → ${after.dynamic}`)
  if (before.tie !== after.tie) diffs.push(after.tie ? '增加延音线' : '取消延音线')
  if (before.expression !== after.expression) diffs.push(`表情 ${before.expression || '无'} → ${after.expression || '无'}`)
  return diffs
}
