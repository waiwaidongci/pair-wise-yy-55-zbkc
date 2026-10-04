import { useMemo, useState } from 'react'
import { Alert, Badge, Button, Card, Col, Descriptions, Empty, Row, Select, Space, Statistic, Tag, Timeline, Tooltip, Typography } from 'antd'
import { CheckCircleOutlined, ClockCircleOutlined, CloudUploadOutlined, ReloadOutlined, SwapOutlined, WarningOutlined } from '@ant-design/icons'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from '../store'
import { mergeCandidate, resolveConflict, retryWrite, submitRevision, toggleWriteFailure, upgradeLegacyDraft } from '../store'
import type { LegacyDraft } from '../types'

const AUTHORS = ['弦乐声部长', '木管声部长']

function noteDiff(base: unknown, ours: unknown, theirs: unknown) {
  const b = (base ?? {}) as Record<string, unknown>
  const o = (ours ?? {}) as Record<string, unknown>
  const t = (theirs ?? {}) as Record<string, unknown>
  const keys = Array.from(new Set([...Object.keys(o), ...Object.keys(t)])).filter((key) => key !== 'id')
  return keys.map((key) => ({
    key,
    base: b[key],
    ours: o[key],
    theirs: t[key],
    changed: JSON.stringify(o[key]) !== JSON.stringify(t[key]),
  }))
}

function NoteValue({ value }: { value: unknown }) {
  if (value === undefined || value === null) return <Typography.Text type="secondary">—</Typography.Text>
  if (typeof value === 'boolean') return <Tag color={value ? 'blue' : 'default'}>{value ? '是' : '否'}</Tag>
  return <span>{String(value)}</span>
}

export default function Handoff() {
  const dispatch = useDispatch<AppDispatch>()
  const { tracks, handoff } = useSelector((state: RootState) => state.score)
  const [partId, setPartId] = useState(tracks[0]!.id)
  const [author, setAuthor] = useState(AUTHORS[0]!)

  const pendingConflicts = handoff.conflicts.filter((item) => item.status === 'pending')
  const activeCandidates = handoff.candidates.filter((item) => item.status !== 'merged')
  const failedWrites = handoff.submissions.filter((item) => item.writeStatus === 'failed')

  const hintsByPart = useMemo(() => {
    const map = new Map<string, typeof handoff.hints>()
    for (const hint of handoff.hints) {
      const list = map.get(hint.partId) ?? []
      list.push(hint)
      map.set(hint.partId, list)
    }
    return map
  }, [handoff.hints])

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">分谱回传 · 三方比较 · 候选与冲突处置</p>
          <h1>回传交接</h1>
          <p>排练后两位声部长各自带回离线校订。回传时按音符标识与评论锚点比较：单边修改直接并入，两边都改过保留双方内容等待处置；同册先到者成为候选，后到内容留成冲突，不静默覆盖；总谱音符、移调或评论一改，受影响候选与换页提示立即失效并按新基线重算；写盘失败从已交声部恢复，重试不重复追加记录；旧稿无声部标识时按现有顺序回填后升级，原出版版本仍可查回。</p>
        </div>
        <Space wrap>
          <Tooltip title="总谱变更后基线移动，候选与换页提示据此重算"><Tag icon={<SwapOutlined />} color="blue">基线 {handoff.baselineVersionId}</Tag></Tooltip>
          <Tooltip title="总谱变更触发的失效重算次数"><Tag color={handoff.recomputeTick ? 'orange' : 'default'}>已按新基线重算 {handoff.recomputeTick} 次</Tag></Tooltip>
          <Tooltip title="开启后首次写盘模拟失败，可演练从已交声部恢复"><Tag color={handoff.simulateWriteFailure ? 'red' : 'green'}>{handoff.simulateWriteFailure ? '模拟写盘失败：开' : '模拟写盘失败：关'}</Tag></Tooltip>
          <Button size="small" onClick={() => dispatch(toggleWriteFailure())}>切换写盘失败</Button>
        </Space>
      </div>

      {handoff.legacyOriginal && (
        <Alert
          style={{ marginBottom: 16 }}
          type="success"
          showIcon
          icon={<CheckCircleOutlined />}
          message="旧稿已升级：按现有顺序回填声部标识并补全字段"
          description={
            <span>原稿已存档，原出版版本仍可查回。回填声部标识：
              {handoff.legacyOriginal.tracks.map((item, index) => (
                <Tag key={item.name} color="blue" style={{ marginLeft: 6 }}>{item.name} → TR-{String(index + 1).padStart(2, '0')}</Tag>
              ))}
            </span>
          }
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card
            title={<span><CloudUploadOutlined /> 出版候选与冲突</span>}
            extra={<Space><Badge status="processing" text={`候选 ${activeCandidates.length}`} /><Badge status="error" text={`待处置冲突 ${pendingConflicts.length}`} /></Space>}
          >
            {tracks.map((track) => {
              const candidate = handoff.candidates.find((item) => item.partId === track.id && item.status !== 'merged')
              const partConflicts = handoff.conflicts.filter((item) => item.partId === track.id && item.status === 'pending')
              const partHints = hintsByPart.get(track.id) ?? []
              return (
                <div key={track.id} className="handoff-part">
                  <div className="handoff-part-head">
                    <div><b>{track.name}</b> <Tag>{track.instrument}</Tag></div>
                    {candidate
                      ? <Tag color={candidate.status === 'invalidated' ? 'orange' : candidate.status === 'merged' ? 'default' : 'green'} icon={candidate.status === 'invalidated' ? <WarningOutlined /> : <CheckCircleOutlined />}>
                          {candidate.status === 'invalidated' ? '已失效 · 待重算' : candidate.status === 'merged' ? '已并入' : '候选 · 可并入'}
                        </Tag>
                      : <Tag>无候选</Tag>}
                  </div>

                  {candidate && candidate.status !== 'merged' && (
                    <div className="handoff-candidate">
                      <Space wrap>
                        <Tag color="blue">单边修改 {candidate.cleanNoteIds.length} 音 / {candidate.cleanCommentIds.length} 评论</Tag>
                        <Tag>基线 {candidate.baselineVersionId}</Tag>
                      </Space>
                      <Button type="primary" size="small" icon={<CheckCircleOutlined />} onClick={() => dispatch(mergeCandidate(candidate.id))} style={{ marginTop: 8 }}>并入总谱</Button>
                    </div>
                  )}

                  {partConflicts.length > 0 && (
                    <div className="handoff-conflicts">
                      {partConflicts.map((conflict) => (
                        <div key={conflict.id} className="conflict-card">
                          <div className="conflict-head">
                            <Tag color="red" icon={<WarningOutlined />}>两边都改</Tag>
                            <span>{conflict.anchorLabel}</span>
                            <Tag>{conflict.kind === 'note' ? '音符标识' : '评论锚点'}</Tag>
                          </div>
                          <div className="conflict-sides">
                            <div className="conflict-side"><b>总谱侧（ours）</b><NoteValue value={conflict.ours} /></div>
                            <div className="conflict-side"><b>回传侧（theirs）</b><NoteValue value={conflict.theirs} /></div>
                          </div>
                          {conflict.kind === 'note' && (
                            <div className="conflict-diff">
                              {noteDiff(conflict.base, conflict.ours, conflict.theirs).filter((item) => item.changed).map((item) => (
                                <div key={item.key} className="diff-row">
                                  <Tag>{item.key}</Tag>
                                  <span>总谱 <NoteValue value={item.ours} /></span>
                                  <span>回传 <NoteValue value={item.theirs} /></span>
                                </div>
                              ))}
                            </div>
                          )}
                          <Space style={{ marginTop: 8 }}>
                            <Button size="small" onClick={() => dispatch(resolveConflict({ conflictId: conflict.id, accept: 'ours' }))}>采用总谱侧</Button>
                            <Button size="small" type="primary" onClick={() => dispatch(resolveConflict({ conflictId: conflict.id, accept: 'theirs' }))}>采用回传侧</Button>
                          </Space>
                        </div>
                      ))}
                    </div>
                  )}

                  {partHints.length > 0 && (
                    <div className="handoff-hints">
                      {partHints.map((hint) => (
                        <Tag key={hint.id} color={hint.valid ? 'cyan' : 'red'} icon={hint.valid ? <ClockCircleOutlined /> : <WarningOutlined />}>
                          换页提示 · 第 {hint.measure} 小节 · {hint.reason}
                        </Tag>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </Card>
        </Col>

        <Col xs={24} xl={10}>
          <Card title={<span><ReloadOutlined /> 声部长回传</span>} style={{ marginBottom: 16 }}>
            <Space wrap>
              <Select value={partId} style={{ width: 180 }} options={tracks.map((item) => ({ value: item.id, label: `${item.name} · ${item.instrument}` }))} onChange={setPartId} />
              <Select value={author} style={{ width: 140 }} options={AUTHORS.map((item) => ({ value: item, label: item }))} onChange={setAuthor} />
              <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => dispatch(submitRevision({ partId, author }))}>回传校订</Button>
            </Space>
            <Alert style={{ marginTop: 12 }} type="info" showIcon message="回传按音符标识与评论锚点三方比较" description="以离线基线为 base：总谱未改、仅回传侧修改 → 单边修改直接并入；两边都改且不一致 → 保留双方内容等待处置。同册先到者成为候选，后到内容留成冲突。" />
          </Card>

          <Card title="写盘记录与恢复" style={{ marginBottom: 16 }}>
            {failedWrites.length > 0 && (
              <Alert
                style={{ marginBottom: 12 }}
                type="warning"
                showIcon
                message={`${failedWrites.length} 册写盘失败，已从已交声部恢复`}
                description="内容未丢失，仍保留在已交声部中。重试按幂等键恢复，不重复追加记录。"
              />
            )}
            {handoff.submissions.length === 0 && <Empty description="暂无回传记录" />}
            <Timeline
              items={handoff.submissions.map((submission) => ({
                color: submission.writeStatus === 'failed' ? 'red' : submission.status === 'merged' ? 'green' : 'blue',
                children: (
                  <div className="write-record">
                    <div><b>{submission.author}</b> 回传《{submission.partName}》 · <Tag>{submission.baseVersionId} 基线</Tag></div>
                    <div className="muted">{submission.submittedAt} · 尝试 {submission.attempts} 次 · {submission.status === 'conflict' ? '后到内容留成冲突' : submission.status === 'merged' ? '已并入总谱' : '候选待并入'}</div>
                    {submission.writeStatus === 'failed' && (
                      <Button size="small" type="primary" danger icon={<ReloadOutlined />} onClick={() => dispatch(retryWrite(submission.token))} style={{ marginTop: 6 }}>重试写盘（不重复追加）</Button>
                    )}
                  </div>
                ),
              }))}
            />
          </Card>

          <Card title="换页提示（由分谱音符派生）" style={{ marginBottom: 16 }}>
            <Row gutter={12}>
              <Col span={8}><Statistic title="有效提示" value={handoff.hints.filter((item) => item.valid).length} valueStyle={{ color: '#059669' }} /></Col>
              <Col span={8}><Statistic title="已失效" value={handoff.hints.filter((item) => !item.valid).length} valueStyle={{ color: '#dc2626' }} /></Col>
              <Col span={8}><Statistic title="重算次数" value={handoff.recomputeTick} valueStyle={{ color: '#2563eb' }} /></Col>
            </Row>
            <div style={{ marginTop: 12 }}>
              {handoff.hints.map((hint) => {
                const part = tracks.find((item) => item.id === hint.partId)
                return (
                  <Tag key={hint.id} color={hint.valid ? 'cyan' : 'red'} style={{ marginBottom: 6 }}>
                    {part?.name} · 第 {hint.measure} 小节 · {hint.reason}
                  </Tag>
                )
              })}
            </div>
          </Card>

          <Card title="旧稿升级">
            <p className="muted">旧稿没有声部标识时，按现有顺序回填声部标识后升级 schema；原出版版本存档仍可查回。</p>
            <Button icon={<ReloadOutlined />} onClick={() => dispatch(upgradeLegacyDraft())}>载入旧稿并按顺序回填升级</Button>
            {handoff.legacyOriginal && (
              <Descriptions style={{ marginTop: 12 }} size="small" column={1} bordered>
                <Descriptions.Item label={`原稿 schema v${handoff.legacyOriginal.schema}`}>
                  保存于 {handoff.legacyOriginal.savedAt} · {handoff.legacyOriginal.tracks.length} 声部（无声部标识）
                </Descriptions.Item>
                <Descriptions.Item label="升级后">
                  {tracks.map((track) => <Tag key={track.id} color="green">{track.id} · {track.name}</Tag>)}
                </Descriptions.Item>
              </Descriptions>
            )}
          </Card>
        </Col>
      </Row>
    </main>
  )
}
