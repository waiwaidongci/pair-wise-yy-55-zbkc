import type { ConflictChoice, PartSubmission, ScoreComment, ScoreVersion, Track } from './types'
import type { PageTurnHint } from './merge'

export const DRAFT_KEY = 'yy55-score-draft'
export const JOURNAL_KEY = 'yy55-handoff-journal'
export const CANDIDATES_KEY = 'yy55-handoff-candidates'

/** 写入磁盘的候选记录；基线修订号落后于现行总谱时即失效，需按新基线重写 */
export interface PersistedCandidate {
  submissionId: string
  trackId: string
  revision: number
  writtenAt: string
  noteCount: number
  autoMerged: number
  conflicts: number
  pageTurnHints: PageTurnHint[]
  resolutions: Record<string, ConflictChoice>
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value))
}

/* ---- 已交声部日志：回传先落日志，再尝试写候选记录，写盘失败可据此恢复 ---- */

export const loadJournal = (): PartSubmission[] => read(JOURNAL_KEY, [])

export function upsertJournal(submission: PartSubmission) {
  const all = loadJournal()
  const index = all.findIndex((item) => item.id === submission.id)
  if (index >= 0) all[index] = submission
  else all.push(submission)
  write(JOURNAL_KEY, all)
}

/* ---- 候选记录：按提交标识幂等写入，重试不会重复追加 ---- */

export const loadCandidates = (): PersistedCandidate[] => read(CANDIDATES_KEY, [])

export function writeCandidate(record: PersistedCandidate) {
  const all = loadCandidates()
  const index = all.findIndex((item) => item.submissionId === record.submissionId)
  if (index >= 0) all[index] = record
  else all.push(record)
  write(CANDIDATES_KEY, all)
}

export function removeCandidateRecord(submissionId: string) {
  write(CANDIDATES_KEY, loadCandidates().filter((item) => item.submissionId !== submissionId))
}

export interface RecoveredHandoff {
  submissions: PartSubmission[]
  candidates: PersistedCandidate[]
  /** 已交声部已落日志、但候选记录写盘未成功的提交 */
  recoveredIds: string[]
}

export function recoverHandoff(): RecoveredHandoff {
  const submissions = loadJournal()
  const candidates = loadCandidates()
  const recoveredIds = submissions
    .filter((item) => item.status === 'returned' && !candidates.some((record) => record.submissionId === item.id))
    .map((item) => item.id)
  return { submissions, candidates, recoveredIds }
}

/* ---- 旧稿升级：没有声部标识时按现有顺序回填，原出版版本保留可查 ---- */

export interface MigratedDraft {
  tracks: Track[]
  comments: ScoreComment[]
  versions: ScoreVersion[]
  migrations: string[]
}

export function migrateDraft(raw: unknown): MigratedDraft | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { tracks?: unknown }).tracks)) return null
  const draft = raw as { schemaVersion?: number; tracks: Array<Record<string, unknown>>; comments?: ScoreComment[]; versions?: ScoreVersion[] }
  const migrations: string[] = []
  const tracks = draft.tracks.map((track, index) => {
    let id = track.id as string | undefined
    if (!id) {
      id = `TR-0${index + 1}`
      migrations.push(`旧稿声部「${(track.name as string) ?? `第 ${index + 1} 册`}」缺少声部标识，已按现有顺序回填为 ${id}`)
    }
    let notesBackfilled = false
    const notes = ((track.notes as Array<Record<string, unknown>>) ?? []).map((note, noteIndex) => {
      if (note.id) return note
      notesBackfilled = true
      return { ...note, id: `N-${id}-${noteIndex + 1}` }
    })
    if (notesBackfilled) migrations.push(`声部 ${id} 的音符缺少标识，已按现有顺序回填`)
    return { ...track, id, notes } as unknown as Track
  })
  const versions = (draft.versions ?? []).map((version) => ({ ...version, legacy: true }))
  if (draft.schemaVersion !== 2) migrations.push(`旧稿已升级为 v2 结构，${versions.length} 个原出版版本保留可查`)
  return { tracks, comments: draft.comments ?? [], versions, migrations }
}

export function plantLegacyDraft(sample: unknown) {
  write(DRAFT_KEY, sample)
}
