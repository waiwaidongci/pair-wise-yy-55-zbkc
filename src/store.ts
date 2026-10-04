import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react'
import type { LegacyDraft, MergeCandidate, PageTurnHint, PartSubmission, PendingConflict, ScoreComment, ScoreNote, ScoreVersion, Track } from './types'
import { seedComments, seedTracks, seedVersions } from './mock'
import { computeHints, computeMerge, legacyDraftSample, makeRevision, threeWayMerge, upgradeLegacyDraft as upgradeLegacyDraftData } from './handoff'

interface ScoreState {
  tracks: Track[]
  selectedTrackId: string
  selectedNoteIndex: number
  history: string[]
  future: string[]
  comments: ScoreComment[]
  versions: ScoreVersion[]
  dirty: boolean
  handoff: HandoffState
}

interface HandoffState {
  baselineVersionId: string
  submissions: PartSubmission[]
  candidates: MergeCandidate[]
  conflicts: PendingConflict[]
  hints: PageTurnHint[]
  simulateWriteFailure: boolean
  legacyOriginal: LegacyDraft | null
  recomputeTick: number
}

const clone = <T>(value: T): T => structuredClone(value)

// 种子：已回传的两册（长笛），先到为候选、后到留冲突
function seedHandoff(): HandoffState {
  const baseline = clone(seedTracks)
  const flute = baseline[0]!
  const s1Notes = makeRevision(flute, 'v12', '弦乐声部长').notes
  const s2Notes = makeRevision(flute, 'v12', '木管声部长').notes
  const s1: PartSubmission = {
    id: 'S-1', token: 'TK-SEED-1', partId: 'TR-01', partName: '长笛', author: '弦乐声部长',
    baseVersionId: 'v12', submittedAt: '今天 17:02',
    baseNotes: clone(flute.notes), baseComments: clone(seedComments),
    notes: s1Notes, comments: [], status: 'candidate', writeStatus: 'written', attempts: 1,
  }
  const s2: PartSubmission = {
    id: 'S-2', token: 'TK-SEED-2', partId: 'TR-01', partName: '长笛', author: '木管声部长',
    baseVersionId: 'v12', submittedAt: '今天 17:05',
    baseNotes: clone(flute.notes), baseComments: clone(seedComments),
    notes: s2Notes, comments: [], status: 'conflict', writeStatus: 'written', attempts: 1,
  }
  const candidate: MergeCandidate = {
    id: 'C-1', partId: 'TR-01', submissionId: 'S-1', baselineVersionId: 'v12', status: 'active',
    cleanNoteIds: ['N-3', 'N-6', 'N-8'], cleanCommentIds: [], conflictIds: ['CF-1'],
  }
  // 两位声部长对第 3 个音（N-3）力度修改不一致：p vs f
  const n3Base = flute.notes[2]!
  const conflict: PendingConflict = {
    id: 'CF-1', partId: 'TR-01', submissionId: 'S-2', kind: 'note', targetId: 'N-3',
    anchorLabel: '音符 N-3（第 1 小节第 3 拍）',
    base: clone(n3Base), ours: { ...clone(n3Base), dynamic: 'p' }, theirs: { ...clone(n3Base), dynamic: 'f' },
    status: 'pending',
  }
  return {
    baselineVersionId: 'v12',
    submissions: [s1, s2],
    candidates: [candidate],
    conflicts: [conflict],
    hints: computeHints(baseline, 'v12'),
    simulateWriteFailure: true,
    legacyOriginal: null,
    recomputeTick: 0,
  }
}

const initialState: ScoreState = {
  tracks: clone(seedTracks), selectedTrackId: 'TR-01', selectedNoteIndex: 2, history: [], future: [], comments: clone(seedComments), versions: clone(seedVersions), dirty: false,
  handoff: seedHandoff(),
}

function snapshot(state: ScoreState) { state.history.push(JSON.stringify(state.tracks)); if (state.history.length > 40) state.history.shift(); state.future = []; state.dirty = true; localStorage.setItem('yy55-score-draft', JSON.stringify({ tracks: state.tracks, comments: state.comments })) }
function transposeKey(key: string, semitones: number) {
  const chromatic = ['c','c#','d','d#','e','f','f#','g','g#','a','a#','b']
  const [pitch, octaveText] = key.split('/')
  let index = chromatic.indexOf(pitch!.replace('b', '')) + semitones
  let octave = Number(octaveText)
  while (index < 0) { index += 12; octave -= 1 }
  while (index >= 12) { index -= 12; octave += 1 }
  return `${chromatic[index]}/${octave}`
}

let seq = 100
function nextId(prefix: string) { seq += 1; return `${prefix}-${seq}` }

// 候选晋升：先到者成为候选，后到内容留成冲突，不静默覆盖
function promoteSubmission(state: ScoreState, submission: PartSubmission) {
  const track = state.tracks.find((item) => item.id === submission.partId)
  if (!track) return
  const existingCandidate = state.handoff.candidates.find((item) => item.partId === submission.partId && item.status !== 'merged')
  if (existingCandidate) {
    submission.status = 'conflict'
    const existing = state.handoff.submissions.find((item) => item.id === existingCandidate.submissionId)
    if (existing) {
      const notes = threeWayMerge(submission.baseNotes, existing.notes, submission.notes)
      for (const item of notes.conflicts) {
        state.handoff.conflicts.push({
          id: nextId('CF'), partId: submission.partId, submissionId: submission.id, kind: 'note',
          targetId: item.id, anchorLabel: `音符 ${item.id}`,
          base: item.base ?? null, ours: item.ours ?? null, theirs: item.theirs ?? null, status: 'pending',
        })
      }
      const comments = threeWayMerge(submission.baseComments, existing.comments, submission.comments)
      for (const item of comments.conflicts) {
        const anchor = item.theirs ?? item.ours ?? item.base
        state.handoff.conflicts.push({
          id: nextId('CF'), partId: submission.partId, submissionId: submission.id, kind: 'comment',
          targetId: item.id, anchorLabel: `第 ${(anchor as ScoreComment | undefined)?.measure ?? '?'} 小节评论锚点`,
          base: item.base ?? null, ours: item.ours ?? null, theirs: item.theirs ?? null, status: 'pending',
        })
      }
    }
    return
  }
  submission.status = 'candidate'
  const merge = computeMerge(track, state.comments, submission)
  const candidate: MergeCandidate = {
    id: nextId('C'), partId: submission.partId, submissionId: submission.id,
    baselineVersionId: state.handoff.baselineVersionId, status: 'active',
    cleanNoteIds: merge.cleanNoteIds, cleanCommentIds: merge.cleanCommentIds,
    conflictIds: merge.conflicts.map(() => nextId('CF')),
  }
  state.handoff.candidates.push(candidate)
  merge.conflicts.forEach((item, index) => {
    state.handoff.conflicts.push({ ...item, id: candidate.conflictIds[index]!, partId: submission.partId, submissionId: submission.id, status: 'pending' })
  })
}

// 总谱基线一变，候选与换页提示立即失效，并按新基线重算
function recomputeHandoff(state: ScoreState, baselineId?: string) {
  state.handoff.recomputeTick += 1
  state.handoff.baselineVersionId = baselineId ?? `draft-${state.handoff.recomputeTick}`
  for (const candidate of state.handoff.candidates) {
    if (candidate.status === 'active') candidate.status = 'invalidated'
  }
  for (const candidate of state.handoff.candidates) {
    if (candidate.status === 'merged') continue
    const submission = state.handoff.submissions.find((item) => item.id === candidate.submissionId)
    const track = state.tracks.find((item) => item.id === candidate.partId)
    if (!submission || !track) continue
    const merge = computeMerge(track, state.comments, submission)
    candidate.cleanNoteIds = merge.cleanNoteIds
    candidate.cleanCommentIds = merge.cleanCommentIds
    candidate.baselineVersionId = state.handoff.baselineVersionId
    candidate.status = 'active'
    // 清掉该回传旧的待处置冲突，按新基线重新生成（已处置的保留）
    state.handoff.conflicts = state.handoff.conflicts.filter((item) => !(item.submissionId === submission.id && item.status === 'pending'))
    merge.conflicts.forEach((item, index) => {
      state.handoff.conflicts.push({ ...item, id: candidate.conflictIds[index] ?? nextId('CF'), partId: submission.partId, submissionId: submission.id, status: 'pending' })
    })
  }
  state.handoff.hints = computeHints(state.tracks, state.handoff.baselineVersionId)
}

const scoreSlice = createSlice({
  name: 'score',
  initialState,
  reducers: {
    selectTrack(state, action: PayloadAction<string>) { state.selectedTrackId = action.payload; state.selectedNoteIndex = 0 },
    selectNote(state, action: PayloadAction<number>) { state.selectedNoteIndex = action.payload },
    addNote(state) {
      snapshot(state); const track = state.tracks.find((item) => item.id === state.selectedTrackId)!; const template = track.notes[Math.min(track.notes.length - 1, state.selectedNoteIndex)]
      track.notes.splice(state.selectedNoteIndex + 1, 0, { id: `N-${Date.now()}`, key: template?.key ?? 'c/4', duration: 'q', dynamic: template?.dynamic ?? 'mf', tie: false, expression: '' }); state.selectedNoteIndex += 1
      recomputeHandoff(state)
    },
    removeNote(state) { snapshot(state); const track = state.tracks.find((item) => item.id === state.selectedTrackId)!; if (track.notes.length > 1) track.notes.splice(state.selectedNoteIndex, 1); state.selectedNoteIndex = Math.max(0, state.selectedNoteIndex - 1); recomputeHandoff(state) },
    updateNote(state, action: PayloadAction<Partial<ScoreNote>>) { snapshot(state); const track = state.tracks.find((item) => item.id === state.selectedTrackId)!; Object.assign(track.notes[state.selectedNoteIndex]!, action.payload); recomputeHandoff(state) },
    transposeTrack(state, action: PayloadAction<number>) { snapshot(state); const track = state.tracks.find((item) => item.id === state.selectedTrackId)!; track.notes.forEach((note) => { note.key = transposeKey(note.key, action.payload) }); track.transposition += action.payload; recomputeHandoff(state) },
    undo(state) { const previous = state.history.pop(); if (!previous) return; state.future.push(JSON.stringify(state.tracks)); state.tracks = JSON.parse(previous); state.dirty = true; recomputeHandoff(state) },
    redo(state) { const next = state.future.pop(); if (!next) return; state.history.push(JSON.stringify(state.tracks)); state.tracks = JSON.parse(next); state.dirty = true; recomputeHandoff(state) },
    resolveComment(state, action: PayloadAction<string>) { const comment = state.comments.find((item) => item.id === action.payload); if (comment) comment.resolved = true; state.dirty = true; recomputeHandoff(state) },
    saveVersion(state) { const newId = `v${state.versions.length + 13}`; state.versions.unshift({ id: newId, author: '当前用户', time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }), summary: '保存当前总谱与分谱调整', trackNotes: Object.fromEntries(state.tracks.map((track) => [track.id, structuredClone(track.notes)])) }); state.dirty = false; localStorage.removeItem('yy55-score-draft'); recomputeHandoff(state, newId) },
    restoreDraft(state) { const raw = localStorage.getItem('yy55-score-draft'); if (!raw) return; const draft = JSON.parse(raw); state.tracks = draft.tracks; state.comments = draft.comments; state.dirty = true; recomputeHandoff(state) },

    // 声部长离线校订后回传一册
    submitRevision(state, action: PayloadAction<{ partId: string; author: string }>) {
      const { partId, author } = action.payload
      const track = state.tracks.find((item) => item.id === partId)
      if (!track) return
      const revision = makeRevision(track, state.handoff.baselineVersionId, author)
      const submission: PartSubmission = {
        id: nextId('S'), token: `TK-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        partId, partName: track.name, author,
        baseVersionId: state.handoff.baselineVersionId,
        submittedAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
        baseNotes: clone(track.notes), baseComments: clone(state.comments),
        notes: revision.notes, comments: revision.comments,
        status: 'candidate',
        writeStatus: state.handoff.simulateWriteFailure ? 'failed' : 'written',
        attempts: 1,
      }
      state.handoff.submissions.push(submission)
      // 写盘失败：内容已从已交声部接收，暂不晋升候选，等重试
      if (submission.writeStatus === 'written') promoteSubmission(state, submission)
    },

    // 写盘失败后重试：按幂等键恢复，不重复追加记录
    retryWrite(state, action: PayloadAction<string>) {
      const token = action.payload
      const submission = state.handoff.submissions.find((item) => item.token === token)
      if (!submission) return
      const already = state.handoff.candidates.some((item) => item.submissionId === submission.id)
        || state.handoff.conflicts.some((item) => item.submissionId === submission.id)
      if (already) { submission.writeStatus = 'written'; return }  // 幂等：已晋升，直接返回
      submission.attempts += 1
      submission.writeStatus = 'written'
      promoteSubmission(state, submission)
    },

    // 候选并入总谱：单边修改直接并入
    mergeCandidate(state, action: PayloadAction<string>) {
      const candidate = state.handoff.candidates.find((item) => item.id === action.payload)
      if (!candidate || candidate.status === 'merged') return
      const submission = state.handoff.submissions.find((item) => item.id === candidate.submissionId)
      const track = state.tracks.find((item) => item.id === candidate.partId)
      if (!submission || !track) return
      for (const noteId of candidate.cleanNoteIds) {
        const revised = submission.notes.find((item) => item.id === noteId)
        const index = track.notes.findIndex((item) => item.id === noteId)
        if (revised && index >= 0) track.notes[index] = clone(revised)
      }
      for (const commentId of candidate.cleanCommentIds) {
        const revised = submission.comments.find((item) => item.id === commentId)
        const index = state.comments.findIndex((item) => item.id === commentId)
        if (revised && index >= 0) state.comments[index] = clone(revised)
      }
      candidate.status = 'merged'
      submission.status = 'merged'
      state.dirty = true
      recomputeHandoff(state)
    },

    // 冲突处置：采用总谱侧（ours）或回传侧（theirs）
    resolveConflict(state, action: PayloadAction<{ conflictId: string; accept: 'ours' | 'theirs' }>) {
      const { conflictId, accept } = action.payload
      const conflict = state.handoff.conflicts.find((item) => item.id === conflictId)
      if (!conflict || conflict.status !== 'pending') return
      if (accept === 'theirs') {
        if (conflict.kind === 'note') {
          const track = state.tracks.find((item) => item.id === conflict.partId)
          const index = track?.notes.findIndex((item) => item.id === conflict.targetId) ?? -1
          if (track && index >= 0 && conflict.theirs) track.notes[index] = clone(conflict.theirs as ScoreNote)
        } else {
          const index = state.comments.findIndex((item) => item.id === conflict.targetId)
          if (index >= 0 && conflict.theirs) state.comments[index] = clone(conflict.theirs as ScoreComment)
        }
      }
      conflict.status = accept
      state.dirty = true
      recomputeHandoff(state)
    },

    toggleWriteFailure(state) { state.handoff.simulateWriteFailure = !state.handoff.simulateWriteFailure },

    // 旧稿升级：没有声部标识时按现有顺序回填，原出版版本仍可查回
    upgradeLegacyDraft(state) {
      localStorage.setItem('yy55-score-draft', JSON.stringify(legacyDraftSample))
      const raw = JSON.parse(localStorage.getItem('yy55-score-draft')!) as LegacyDraft
      state.handoff.legacyOriginal = raw   // 存档原稿，仍可查回
      const { tracks, comments } = upgradeLegacyDraftData(raw)
      state.tracks = tracks
      state.comments = comments
      state.dirty = true
      recomputeHandoff(state)
    },
  },
})

export const scoreApi = createApi({
  reducerPath: 'scoreApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getPublishingProfile: builder.query<{ title: string; publisher: string; pages: number; deadline: string }, void>({ queryFn: async () => ({ data: { title: '《潮汐线》室内交响作品', publisher: '云谱出版社', pages: 46, deadline: '2026-10-12' } }) }),
  }),
})

export const { selectTrack, selectNote, addNote, removeNote, updateNote, transposeTrack, undo, redo, resolveComment, saveVersion, restoreDraft, submitRevision, retryWrite, mergeCandidate, resolveConflict, toggleWriteFailure, upgradeLegacyDraft } = scoreSlice.actions
export const store = configureStore({ reducer: { score: scoreSlice.reducer, [scoreApi.reducerPath]: scoreApi.reducer }, middleware: (getDefault) => getDefault().concat(scoreApi.middleware) })
export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
