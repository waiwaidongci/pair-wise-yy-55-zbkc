import type { MergeCandidate, PageTurnHint, PartSubmission, PendingConflict, ScoreComment, ScoreNote, Track } from './types'

// 三方合并：以离线基线为 base，比较总谱侧（ours）与回传侧（theirs）
// 单边修改直接并入；两边都改过且不一致 → 冲突，保留双方内容等待处置
export function threeWayMerge<T extends { id: string }>(base: T[], ours: T[], theirs: T[]) {
  const baseMap = new Map(base.map((item) => [item.id, item]))
  const oursMap = new Map(ours.map((item) => [item.id, item]))
  const theirsMap = new Map(theirs.map((item) => [item.id, item]))
  const ids = new Set([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()])
  const clean: { id: string; value: T }[] = []
  const conflicts: { id: string; base?: T; ours?: T; theirs?: T }[] = []
  for (const id of ids) {
    const b = baseMap.get(id)
    const o = oursMap.get(id)
    const t = theirsMap.get(id)
    const theirsChanged = JSON.stringify(t) !== JSON.stringify(b)
    const oursChanged = JSON.stringify(o) !== JSON.stringify(b)
    if (!theirsChanged) continue                 // 回传侧未改，保持总谱现状
    if (!oursChanged) { if (t) clean.push({ id, value: t }); continue }  // 单边修改 → 直接并入
    if (JSON.stringify(o) === JSON.stringify(t)) continue  // 两边改后一致
    conflicts.push({ id, base: b, ours: o, theirs: t })    // 两边都改 → 冲突
  }
  return { clean, conflicts }
}

export interface MergeResult {
  cleanNoteIds: string[]
  cleanCommentIds: string[]
  conflicts: Omit<PendingConflict, 'id' | 'partId' | 'submissionId' | 'status'>[]
}

export function computeMerge(track: Track, currentComments: ScoreComment[], submission: PartSubmission): MergeResult {
  const notes = threeWayMerge(submission.baseNotes, track.notes, submission.notes)
  const comments = threeWayMerge(submission.baseComments, currentComments, submission.comments)
  const conflicts: MergeResult['conflicts'] = [
    ...notes.conflicts.map((item) => ({
      kind: 'note' as const,
      targetId: item.id,
      anchorLabel: `音符 ${item.id}`,
      base: item.base ?? null,
      ours: item.ours ?? null,
      theirs: item.theirs ?? null,
    })),
    ...comments.conflicts.map((item) => {
      const anchor = item.theirs ?? item.ours ?? item.base
      return {
        kind: 'comment' as const,
        targetId: item.id,
        anchorLabel: `第 ${(anchor as ScoreComment | undefined)?.measure ?? '?'} 小节评论锚点`,
        base: item.base ?? null,
        ours: item.ours ?? null,
        theirs: item.theirs ?? null,
      }
    }),
  ]
  return { cleanNoteIds: notes.clean.map((item) => item.id), cleanCommentIds: comments.clean.map((item) => item.id), conflicts }
}

// 由分谱音符派生换页提示：长音（二分音符）处可安全翻页
export function computeHints(tracks: Track[], baselineVersionId: string): PageTurnHint[] {
  const hints: PageTurnHint[] = []
  const perMeasure = 4
  for (const track of tracks) {
    const totalMeasures = Math.ceil(track.notes.length / perMeasure)
    for (let measure = 0; measure < totalMeasures; measure++) {
      const measureNotes = track.notes.slice(measure * perMeasure, (measure + 1) * perMeasure)
      const last = measureNotes[measureNotes.length - 1]
      if (last && last.duration === 'h') {
        hints.push({
          id: `H-${track.id}-${measure + 1}`,
          partId: track.id,
          measure: measure + 1,
          reason: `第 ${measure + 1} 小节末为长音，可在此翻页`,
          baselineVersionId,
          valid: true,
        })
      }
    }
  }
  return hints
}

// 为回传生成一份确定性的离线修订（模拟声部长在基线版本上的校订）
export function makeRevision(track: Track, baseVersionId: string, author: string): { notes: ScoreNote[]; comments: ScoreComment[] } {
  const notes = track.notes.map((note, index) => {
    if (index === 2) return { ...note, dynamic: 'p' as const }
    if (index === 5) return { ...note, expression: 'dolce' }
    if (index === 7) return { ...note, tie: !note.tie }
    return note
  })
  const comments: ScoreComment[] = [
    { id: `CM-${track.id}-${author === '弦乐声部长' ? 'A' : 'B'}`, measure: 2, author, content: `${track.name}分谱第 2 小节力度随总谱统一为 p，并在第 3 小节末增加连音线。`, resolved: false },
  ]
  void baseVersionId
  return { notes, comments }
}

// 旧稿样例：没有声部标识（track 无 id），音符也无 id
export const legacyDraftSample = {
  app: 'score-publishing-workbench',
  schema: 1,
  savedAt: '2026-09-20 10:12',
  tracks: [
    { name: '长笛', instrument: 'Flute', notes: [
      { key: 'c/5', duration: 'q' }, { key: 'd/5', duration: 'q' }, { key: 'e/5', duration: 'h' }, { key: 'g/5', duration: 'q' },
      { key: 'a/5', duration: 'q' }, { key: 'g/5', duration: 'q' }, { key: 'e/5', duration: 'h' }, { key: 'd/5', duration: 'q' },
    ] },
    { name: '单簧管', instrument: 'Clarinet in Bb', notes: [
      { key: 'd/4', duration: 'q' }, { key: 'e/4', duration: 'q' }, { key: 'f/4', duration: 'h' }, { key: 'a/4', duration: 'q' },
      { key: 'c/5', duration: 'q' }, { key: 'a/4', duration: 'q' }, { key: 'f/4', duration: 'h' }, { key: 'e/4', duration: 'q' },
    ] },
  ],
  comments: [
    { id: 'CM-1', measure: 3, author: '指挥 · 方亦', content: '旧稿第 3 小节长音处考虑翻页。', resolved: false },
  ],
}

// 旧稿升级：按现有顺序回填声部标识，补全缺失字段
export function upgradeLegacyDraft(raw: any): { tracks: Track[]; comments: ScoreComment[] } {
  const palette = ['#2563eb', '#7c3aed', '#d97706', '#059669']
  const clefs: Track['clef'][] = ['treble', 'treble', 'treble', 'bass']
  const transpositions = [0, -2, -7, 0]
  const tracks: Track[] = (raw.tracks ?? []).map((item: any, index: number) => ({
    id: `TR-${String(index + 1).padStart(2, '0')}`,
    name: item.name ?? `声部 ${index + 1}`,
    instrument: item.instrument ?? '',
    clef: item.clef ?? clefs[index] ?? 'treble',
    transposition: item.transposition ?? transpositions[index] ?? 0,
    color: item.color ?? palette[index % palette.length]!,
    notes: (item.notes ?? []).map((note: any, noteIndex: number) => ({
      id: `N-${index + 1}-${noteIndex + 1}`,
      key: note.key ?? 'c/4',
      duration: note.duration ?? 'q',
      accidental: note.accidental,
      dynamic: note.dynamic ?? 'mp',
      tie: note.tie ?? false,
      expression: note.expression ?? '',
    })),
  }))
  const comments: ScoreComment[] = (raw.comments ?? []).map((item: any, index: number) => ({
    id: item.id ?? `CM-L${index + 1}`,
    measure: item.measure ?? index + 1,
    author: item.author ?? '旧稿评论',
    content: item.content ?? '',
    resolved: item.resolved ?? false,
  }))
  return { tracks, comments }
}
