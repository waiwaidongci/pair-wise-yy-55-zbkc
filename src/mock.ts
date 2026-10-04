import type { CommentUpdate, PartSubmission, ScoreComment, ScoreNote, ScoreVersion, Track } from './types'

const notes = (keys: string[]): ScoreNote[] => keys.map((key, index) => ({ id: `N-${index + 1}`, key, duration: index % 4 === 0 ? 'h' : 'q', dynamic: index < 2 ? 'mp' : 'mf', tie: index === 2, expression: index === 3 ? 'dolce' : '' }))

export const seedTracks: Track[] = [
  { id: 'TR-01', name: '长笛', instrument: 'Flute', clef: 'treble', transposition: 0, color: '#2563eb', notes: notes(['c/5','d/5','e/5','g/5','a/5','g/5','e/5','d/5','c/5','e/5','g/5','a/5']) },
  { id: 'TR-02', name: '单簧管', instrument: 'Clarinet in Bb', clef: 'treble', transposition: -2, color: '#7c3aed', notes: notes(['d/4','e/4','f/4','a/4','c/5','a/4','f/4','e/4','d/4','f/4','a/4','c/5']) },
  { id: 'TR-03', name: '圆号', instrument: 'Horn in F', clef: 'treble', transposition: -7, color: '#d97706', notes: notes(['g/3','a/3','c/4','d/4','e/4','d/4','c/4','a/3','g/3','c/4','d/4','e/4']) },
  { id: 'TR-04', name: '大提琴', instrument: 'Violoncello', clef: 'bass', transposition: 0, color: '#059669', notes: notes(['c/3','g/3','e/3','d/3','c/3','g/3','a/3','g/3','c/3','e/3','g/3','a/3']) },
]

export const seedComments: ScoreComment[] = [
  { id: 'CM-1', measure: 2, author: '指挥 · 方亦', content: '圆号第 2 小节进入需再弱一级，避免覆盖大提琴主题。', resolved: false },
  { id: 'CM-2', measure: 3, author: '作曲 · 沈青', content: '第 3 小节末音增加延音线，与下一小节第一拍连奏。', resolved: false },
  { id: 'CM-3', measure: 6, author: '出版 · 赵晴', content: '单簧管分谱需在换页处保留 2 小节提示音。', resolved: true },
  { id: 'CM-4', measure: 3, author: '出版 · 赵晴', content: '长笛分谱第 2 页换页位置待确认，需避开延音线。', resolved: false },
]

export const seedVersions: ScoreVersion[] = [
  { id: 'v12', author: '沈青', time: '今天 16:28', summary: '调整终段和声，补充圆号力度与连音线', trackNotes: { 'TR-03': seedTracks[2]!.notes } },
  { id: 'v11', author: '方亦', time: '今天 14:10', summary: '移调单簧管分谱并调整换气标记', trackNotes: { 'TR-02': seedTracks[1]!.notes } },
]

/* ---- 排练后两位声部长带回的离线校订（首次启动时落日志） ---- */

export function seedHandoffSubmissions(): PartSubmission[] {
  const fluteBaseline = structuredClone(seedTracks[0]!.notes)
  const fluteNotes = structuredClone(seedTracks[0]!.notes)
  fluteNotes[4] = { ...fluteNotes[4]!, dynamic: 'f', expression: 'cantabile' }
  fluteNotes[8] = { ...fluteNotes[8]!, duration: '8' }

  // 圆号：带回后指挥已在现行总谱给第 3 音加了延音线，声部长离线改了力度 → 两边都改过
  const hornBaseline = structuredClone(seedTracks[2]!.notes).map((note, index) => (index === 2 ? { ...note, tie: false } : note))
  const hornNotes = structuredClone(hornBaseline)
  hornNotes[1] = { ...hornNotes[1]!, dynamic: 'p' }
  hornNotes[2] = { ...hornNotes[2]!, dynamic: 'f' }

  return [
    {
      id: 'SUB-01', trackId: 'TR-01', trackName: '长笛', author: '长笛声部长 · 林晚',
      submittedAt: '今天 18:02', baseVersionId: 'v12', baseRevision: 0, baselineTransposition: 0,
      baselineNotes: fluteBaseline, baselineComments: structuredClone(seedComments),
      notes: fluteNotes, commentUpdates: [], status: 'returned',
    },
    {
      id: 'SUB-02', trackId: 'TR-03', trackName: '圆号', author: '圆号声部长 · 周衡',
      submittedAt: '今天 18:15', baseVersionId: 'v12', baseRevision: 0, baselineTransposition: -7,
      baselineNotes: hornBaseline, baselineComments: structuredClone(seedComments),
      notes: hornNotes,
      commentUpdates: [{ id: 'CM-1', resolved: true, content: '圆号第 2 小节进入需再弱一级，避免覆盖大提琴主题。（已按评论调整为 p）' }],
      status: 'returned',
    },
  ]
}

/* ---- 可继续模拟的回传模板：以提交瞬间的现行总谱为基线 ---- */

export interface RevisionTemplate {
  id: string
  label: string
  trackId: string
  author: string
  summary: string
  apply: (notes: ScoreNote[]) => { notes: ScoreNote[]; commentUpdates: CommentUpdate[] }
}

export const revisionTemplates: RevisionTemplate[] = [
  {
    id: 'TPL-CL', label: '单簧管回传', trackId: 'TR-02', author: '单簧管声部长 · 陆远',
    summary: '第 3 小节末音加延音线（应用 CM-2），第 6 音力度改 mp',
    apply: (notes) => {
      const next = structuredClone(notes)
      if (next[11]) next[11] = { ...next[11], tie: true }
      if (next[5]) next[5] = { ...next[5], dynamic: 'mp' }
      return { notes: next, commentUpdates: [{ id: 'CM-2', resolved: true, content: '第 3 小节末音增加延音线，与下一小节第一拍连奏。（单簧管已落实）' }] }
    },
  },
  {
    id: 'TPL-HN2', label: '圆号再回传（后到）', trackId: 'TR-03', author: '圆号副声部长 · 吴桐',
    summary: '第 2 音力度改 pp，第 4 音加 marcato —— 同册后到，应留作冲突',
    apply: (notes) => {
      const next = structuredClone(notes)
      if (next[1]) next[1] = { ...next[1], dynamic: 'pp' }
      if (next[3]) next[3] = { ...next[3], expression: 'marcato' }
      return { notes: next, commentUpdates: [] }
    },
  },
  {
    id: 'TPL-VC', label: '大提琴回传', trackId: 'TR-04', author: '大提琴声部长 · 陈默',
    summary: '首音力度改 p，第 5 音音高 c/3 → e/3',
    apply: (notes) => {
      const next = structuredClone(notes)
      if (next[0]) next[0] = { ...next[0], dynamic: 'p' }
      if (next[4]) next[4] = { ...next[4], key: 'e/3' }
      return { notes: next, commentUpdates: [] }
    },
  },
]

/* ---- 旧稿样例：v1 结构，声部与音符都没有标识，含原出版版本 ---- */

export const legacyDraftSample = {
  schemaVersion: 1,
  tracks: [
    { name: '长笛', instrument: 'Flute', clef: 'treble', transposition: 0, color: '#2563eb', notes: [{ key: 'c/5', duration: 'h', dynamic: 'mp', tie: false, expression: '' }, { key: 'e/5', duration: 'q', dynamic: 'mp', tie: false, expression: '' }, { key: 'g/5', duration: 'q', dynamic: 'mf', tie: true, expression: '' }] },
    { name: '大提琴', instrument: 'Violoncello', clef: 'bass', transposition: 0, color: '#059669', notes: [{ key: 'c/3', duration: 'h', dynamic: 'mp', tie: false, expression: '' }, { key: 'g/3', duration: 'q', dynamic: 'mf', tie: false, expression: '' }, { key: 'e/3', duration: 'q', dynamic: 'mf', tie: false, expression: '' }] },
  ],
  comments: [{ id: 'CM-1', measure: 2, author: '指挥 · 方亦', content: '圆号第 2 小节进入需再弱一级，避免覆盖大提琴主题。', resolved: false }],
  versions: [
    { id: 'v9', author: '沈青', time: '周一 17:40', summary: '原出版版本 · 初稿定版', trackNotes: { 'TR-01': [{ id: 'N-1', key: 'c/5', duration: 'h', dynamic: 'mp', tie: false, expression: '' }] } },
    { id: 'v10', author: '方亦', time: '周三 11:05', summary: '原出版版本 · 排练后力度修订', trackNotes: { 'TR-04': [{ id: 'N-1', key: 'c/3', duration: 'h', dynamic: 'p', tie: false, expression: '' }] } },
  ],
}
