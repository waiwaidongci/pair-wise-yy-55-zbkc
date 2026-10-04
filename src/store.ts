import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react'
import type { ConflictChoice, PartSubmission, ScoreComment, ScoreNote, ScoreVersion, SubmissionStatus, Track } from './types'
import { legacyDraftSample, revisionTemplates, seedComments, seedHandoffSubmissions, seedTracks, seedVersions } from './mock'
import { computeCandidate } from './merge'
import { DRAFT_KEY, JOURNAL_KEY, migrateDraft, plantLegacyDraft, recoverHandoff, removeCandidateRecord, upsertJournal, writeCandidate, type PersistedCandidate } from './persistence'

interface ScoreState {
  tracks: Track[]
  selectedTrackId: string
  selectedNoteIndex: number
  history: string[]
  future: string[]
  comments: ScoreComment[]
  versions: ScoreVersion[]
  dirty: boolean
  /** 基线修订号：总谱音符、移调或评论每改一次即递增，候选与换页提示据此失效重算 */
  revision: number
  migrations: string[]
}

const initialState: ScoreState = {
  tracks: structuredClone(seedTracks), selectedTrackId: 'TR-01', selectedNoteIndex: 2, history: [], future: [], comments: structuredClone(seedComments), versions: structuredClone(seedVersions), dirty: false, revision: 0, migrations: [],
}

function snapshot(state: ScoreState) { state.history.push(JSON.stringify(state.tracks)); if (state.history.length > 40) state.history.shift(); state.future = []; state.dirty = true; localStorage.setItem(DRAFT_KEY, JSON.stringify({ schemaVersion: 2, tracks: state.tracks, comments: state.comments })) }
function transposeKey(key: string, semitones: number) {
  const chromatic = ['c','c#','d','d#','e','f','f#','g','g#','a','a#','b']
  const [pitch, octaveText] = key.split('/')
  let index = chromatic.indexOf(pitch!.replace('b', '')) + semitones
  let octave = Number(octaveText)
  while (index < 0) { index += 12; octave -= 1 }
  while (index >= 12) { index -= 12; octave += 1 }
  return `${chromatic[index]}/${octave}`
}

const scoreSlice = createSlice({
  name: 'score',
  initialState,
  reducers: {
    selectTrack(state, action: PayloadAction<string>) { state.selectedTrackId = action.payload; state.selectedNoteIndex = 0 },
    selectNote(state, action: PayloadAction<number>) { state.selectedNoteIndex = action.payload },
    addNote(state) {
      snapshot(state); state.revision += 1; const track = state.tracks.find((item) => item.id === state.selectedTrackId)!; const template = track.notes[Math.min(track.notes.length - 1, state.selectedNoteIndex)]
      track.notes.splice(state.selectedNoteIndex + 1, 0, { id: `N-${Date.now()}`, key: template?.key ?? 'c/4', duration: 'q', dynamic: template?.dynamic ?? 'mf', tie: false, expression: '' }); state.selectedNoteIndex += 1
    },
    removeNote(state) { snapshot(state); state.revision += 1; const track = state.tracks.find((item) => item.id === state.selectedTrackId)!; if (track.notes.length > 1) track.notes.splice(state.selectedNoteIndex, 1); state.selectedNoteIndex = Math.max(0, state.selectedNoteIndex - 1) },
    updateNote(state, action: PayloadAction<Partial<ScoreNote>>) { snapshot(state); state.revision += 1; const track = state.tracks.find((item) => item.id === state.selectedTrackId)!; Object.assign(track.notes[state.selectedNoteIndex]!, action.payload) },
    transposeTrack(state, action: PayloadAction<number>) { snapshot(state); state.revision += 1; const track = state.tracks.find((item) => item.id === state.selectedTrackId)!; track.notes.forEach((note) => { note.key = transposeKey(note.key, action.payload) }); track.transposition += action.payload },
    undo(state) { const previous = state.history.pop(); if (!previous) return; state.future.push(JSON.stringify(state.tracks)); state.tracks = JSON.parse(previous); state.revision += 1; state.dirty = true },
    redo(state) { const next = state.future.pop(); if (!next) return; state.history.push(JSON.stringify(state.tracks)); state.tracks = JSON.parse(next); state.revision += 1; state.dirty = true },
    resolveComment(state, action: PayloadAction<string>) { const comment = state.comments.find((item) => item.id === action.payload); if (comment) comment.resolved = true; state.revision += 1; state.dirty = true },
    applyMergedTrack(state, action: PayloadAction<{ trackId: string; notes: ScoreNote[]; comments: ScoreComment[] }>) { snapshot(state); const track = state.tracks.find((item) => item.id === action.payload.trackId); if (track) track.notes = action.payload.notes; state.comments = action.payload.comments; state.revision += 1 },
    dismissMigrations(state) { state.migrations = [] },
    saveVersion(state) { state.versions.unshift({ id: `v${state.versions.length + 13}`, author: '当前用户', time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }), summary: '保存当前总谱与分谱调整', trackNotes: Object.fromEntries(state.tracks.map((track) => [track.id, structuredClone(track.notes)])) }); state.dirty = false; localStorage.removeItem(DRAFT_KEY) },
    restoreDraft(state) {
      const raw = localStorage.getItem(DRAFT_KEY); if (!raw) return
      let parsed: unknown; try { parsed = JSON.parse(raw) } catch { return }
      const migrated = migrateDraft(parsed); if (!migrated) return
      state.tracks = migrated.tracks; state.comments = migrated.comments
      const known = new Set(state.versions.map((version) => version.id))
      state.versions.push(...migrated.versions.filter((version) => !known.has(version.id)))
      state.migrations = migrated.migrations
      state.revision += 1; state.dirty = true
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ schemaVersion: 2, tracks: state.tracks, comments: state.comments }))
    },
  },
})

/* ---- 交接：已交声部、出版候选、写盘恢复 ---- */

interface HandoffState {
  submissions: PartSubmission[]
  /** 冲突处置选择，键为 `${submissionId}:${noteId}` 或 `${submissionId}:c:${commentId}` */
  resolutions: Record<string, ConflictChoice>
  writeErrors: Record<string, string>
  persisted: Record<string, PersistedCandidate>
  failNextWrite: boolean
  recoveredIds: string[]
  seq: number
}

function initHandoff(): HandoffState {
  const state: HandoffState = { submissions: [], resolutions: {}, writeErrors: {}, persisted: {}, failNextWrite: false, recoveredIds: [], seq: 0 }
  try {
    if (localStorage.getItem(JOURNAL_KEY) === null) {
      // 首次启动：两位声部长带回的离线校订先落日志，再写候选记录
      const submissions = seedHandoffSubmissions()
      for (const submission of submissions) {
        upsertJournal(submission)
        const track = seedTracks.find((item) => item.id === submission.trackId)!
        const result = computeCandidate(submission, track, seedComments, {})
        const record: PersistedCandidate = { submissionId: submission.id, trackId: submission.trackId, revision: 0, writtenAt: submission.submittedAt, noteCount: result.notes.length, autoMerged: result.noteChanges.length, conflicts: result.noteConflicts.length + result.commentConflicts.length, pageTurnHints: result.pageTurnHints, resolutions: {} }
        writeCandidate(record)
        state.persisted[submission.id] = record
      }
      state.submissions = submissions
      state.seq = submissions.length
      return state
    }
    // 写盘失败过的会话从这里恢复：已交声部以日志为准，缺候选记录的标记待重试
    const recovered = recoverHandoff()
    state.submissions = recovered.submissions
    state.recoveredIds = recovered.recoveredIds
    state.seq = recovered.submissions.length
    for (const record of recovered.candidates) {
      state.persisted[record.submissionId] = record
      for (const [key, choice] of Object.entries(record.resolutions ?? {})) state.resolutions[`${record.submissionId}:${key}`] = choice
    }
    for (const id of recovered.recoveredIds) state.writeErrors[id] = '上次写盘未完成，已从已交声部恢复'
    return state
  } catch {
    return state
  }
}

const handoffSlice = createSlice({
  name: 'handoff',
  initialState: initHandoff(),
  reducers: {
    addSubmission(state, action: PayloadAction<PartSubmission>) { state.submissions.push(action.payload); state.seq += 1 },
    setSubmissionStatus(state, action: PayloadAction<{ submissionId: string; status: SubmissionStatus }>) { const submission = state.submissions.find((item) => item.id === action.payload.submissionId); if (submission) submission.status = action.payload.status },
    setResolution(state, action: PayloadAction<{ key: string; choice: ConflictChoice }>) { state.resolutions[action.payload.key] = action.payload.choice },
    clearResolutionsFor(state, action: PayloadAction<string>) { for (const key of Object.keys(state.resolutions)) if (key.startsWith(`${action.payload}:`)) delete state.resolutions[key] },
    setFailNextWrite(state, action: PayloadAction<boolean>) { state.failNextWrite = action.payload },
    markPersisted(state, action: PayloadAction<PersistedCandidate>) { state.persisted[action.payload.submissionId] = action.payload; delete state.writeErrors[action.payload.submissionId]; state.recoveredIds = state.recoveredIds.filter((id) => id !== action.payload.submissionId) },
    markWriteError(state, action: PayloadAction<{ submissionId: string; message: string }>) { state.writeErrors[action.payload.submissionId] = action.payload.message },
    dropPersisted(state, action: PayloadAction<string>) { delete state.persisted[action.payload] },
  },
})

export const scoreApi = createApi({
  reducerPath: 'scoreApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getPublishingProfile: builder.query<{ title: string; publisher: string; pages: number; deadline: string }, void>({ queryFn: async () => ({ data: { title: '《潮汐线》室内交响作品', publisher: '云谱出版社', pages: 46, deadline: '2026-10-12' } }) }),
  }),
})

export const { selectTrack, selectNote, addNote, removeNote, updateNote, transposeTrack, undo, redo, resolveComment, applyMergedTrack, dismissMigrations, saveVersion, restoreDraft } = scoreSlice.actions
export const { addSubmission, setSubmissionStatus, setResolution, clearResolutionsFor, setFailNextWrite, markPersisted, markWriteError, dropPersisted } = handoffSlice.actions
export const store = configureStore({ reducer: { score: scoreSlice.reducer, handoff: handoffSlice.reducer, [scoreApi.reducerPath]: scoreApi.reducer }, middleware: (getDefault) => getDefault().concat(scoreApi.middleware) })
export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
export type AppThunk<Return = void> = (dispatch: AppDispatch, getState: () => RootState) => Return

/* ---- 交接选择器与流程动作 ---- */

export function resolutionsFor(all: Record<string, ConflictChoice>, submissionId: string): Record<string, ConflictChoice> {
  const prefix = `${submissionId}:`
  const picked: Record<string, ConflictChoice> = {}
  for (const [key, choice] of Object.entries(all)) if (key.startsWith(prefix)) picked[key.slice(prefix.length)] = choice
  return picked
}

/** 同一册的回传按到达顺序排列：先到者为候选，后到内容留作冲突，不静默覆盖 */
export function returnedForTrack(state: RootState, trackId: string): PartSubmission[] {
  return state.handoff.submissions.filter((item) => item.trackId === trackId && item.status === 'returned')
}

export function submitRevision(templateId: string): AppThunk<string | undefined> {
  return (dispatch, getState) => {
    const template = revisionTemplates.find((item) => item.id === templateId)
    const state = getState()
    const track = template ? state.score.tracks.find((item) => item.id === template.trackId) : undefined
    if (!template || !track) return undefined
    const { notes, commentUpdates } = template.apply(track.notes)
    const submission: PartSubmission = {
      id: `SUB-${String(state.handoff.seq + 1).padStart(2, '0')}-${Date.now().toString(36)}`,
      trackId: track.id,
      trackName: track.name,
      author: template.author,
      submittedAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
      baseVersionId: state.score.versions[0]?.id ?? 'v12',
      baseRevision: state.score.revision,
      baselineTransposition: track.transposition,
      baselineNotes: structuredClone(track.notes),
      baselineComments: structuredClone(state.score.comments),
      notes,
      commentUpdates,
      status: 'returned',
    }
    dispatch(addSubmission(submission))
    upsertJournal(submission)
    dispatch(attemptPersist(submission.id))
    return submission.id
  }
}

/** 写候选记录：按提交标识幂等写入，写盘失败后可安全重试，不会重复追加 */
export function attemptPersist(submissionId: string): AppThunk {
  return (dispatch, getState) => {
    const state = getState()
    const submission = state.handoff.submissions.find((item) => item.id === submissionId)
    if (!submission || submission.status !== 'returned') return
    const track = state.score.tracks.find((item) => item.id === submission.trackId)
    if (!track) return
    const resolutions = resolutionsFor(state.handoff.resolutions, submissionId)
    const result = computeCandidate(submission, track, state.score.comments, resolutions)
    if (state.handoff.failNextWrite) {
      dispatch(setFailNextWrite(false))
      dispatch(markWriteError({ submissionId, message: '模拟写盘失败：候选记录未写入，已交声部仍在日志中' }))
      return
    }
    try {
      const record: PersistedCandidate = {
        submissionId,
        trackId: submission.trackId,
        revision: state.score.revision,
        writtenAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
        noteCount: result.notes.length,
        autoMerged: result.noteChanges.length,
        conflicts: result.noteConflicts.length + result.commentConflicts.length,
        pageTurnHints: result.pageTurnHints,
        resolutions,
      }
      writeCandidate(record)
      dispatch(markPersisted(record))
    } catch (error) {
      dispatch(markWriteError({ submissionId, message: `写盘失败：${String(error)}` }))
    }
  }
}

export function acceptCandidate(submissionId: string): AppThunk<boolean> {
  return (dispatch, getState) => {
    const state = getState()
    const submission = state.handoff.submissions.find((item) => item.id === submissionId)
    if (!submission || submission.status !== 'returned') return false
    const track = state.score.tracks.find((item) => item.id === submission.trackId)
    if (!track) return false
    const resolutions = resolutionsFor(state.handoff.resolutions, submissionId)
    const result = computeCandidate(submission, track, state.score.comments, resolutions)
    const unresolved = result.noteConflicts.some((conflict) => resolutions[conflict.noteId] === undefined) || result.commentConflicts.some((conflict) => resolutions[`c:${conflict.commentId}`] === undefined)
    if (unresolved) return false
    dispatch(applyMergedTrack({ trackId: submission.trackId, notes: result.notes, comments: result.comments }))
    dispatch(setSubmissionStatus({ submissionId, status: 'merged' }))
    dispatch(clearResolutionsFor(submissionId))
    dispatch(dropPersisted(submissionId))
    removeCandidateRecord(submissionId)
    const updated = getState().handoff.submissions.find((item) => item.id === submissionId)
    if (updated) upsertJournal(updated)
    return true
  }
}

export function rejectCandidate(submissionId: string): AppThunk {
  return (dispatch, getState) => {
    dispatch(setSubmissionStatus({ submissionId, status: 'rejected' }))
    dispatch(clearResolutionsFor(submissionId))
    dispatch(dropPersisted(submissionId))
    removeCandidateRecord(submissionId)
    const updated = getState().handoff.submissions.find((item) => item.id === submissionId)
    if (updated) upsertJournal(updated)
  }
}

/** 载入没有声部标识的旧稿：按现有顺序回填升级，原出版版本并入版本列表可查回 */
export function loadLegacyDraftSample(): AppThunk {
  return (dispatch) => {
    plantLegacyDraft(legacyDraftSample)
    dispatch(restoreDraft())
  }
}
