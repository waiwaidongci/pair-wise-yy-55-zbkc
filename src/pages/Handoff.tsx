import { useMemo } from 'react'
import { Alert, Button, Card, Col, Empty, Popconfirm, Radio, Row, Space, Switch, Table, Tag, message } from 'antd'
import { CloudUploadOutlined, HistoryOutlined, ReloadOutlined } from '@ant-design/icons'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import type { AppDispatch, RootState } from '../store'
import { acceptCandidate, attemptPersist, dismissMigrations, loadLegacyDraftSample, rejectCandidate, setFailNextWrite, setResolution, submitRevision } from '../store'
import { computeCandidate, describeNote, diffNoteFields } from '../merge'
import { revisionTemplates } from '../mock'
import type { ConflictChoice, PartSubmission, Track } from '../types'

function CandidateCard({ track, candidate, queued }: { track: Track; candidate: PartSubmission; queued: PartSubmission[] }) {
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()
  const comments = useSelector((state: RootState) => state.score.comments)
  const revision = useSelector((state: RootState) => state.score.revision)
  const allResolutions = useSelector((state: RootState) => state.handoff.resolutions)
  const record = useSelector((state: RootState) => state.handoff.persisted[candidate.id])
  const writeError = useSelector((state: RootState) => state.handoff.writeErrors[candidate.id])

  const resolutions = useMemo(() => {
    const prefix = `${candidate.id}:`
    const picked: Record<string, ConflictChoice> = {}
    for (const [key, choice] of Object.entries(allResolutions)) if (key.startsWith(prefix)) picked[key.slice(prefix.length)] = choice
    return picked
  }, [allResolutions, candidate.id])

  const result = useMemo(() => computeCandidate(candidate, track, comments, resolutions), [candidate, track, comments, resolutions])
  const unresolved = result.noteConflicts.filter((conflict) => resolutions[conflict.noteId] === undefined).length + result.commentConflicts.filter((conflict) => resolutions[`c:${conflict.commentId}`] === undefined).length
  const baselineMoved = candidate.baseRevision !== revision
  const transpositionMoved = candidate.baselineTransposition !== track.transposition
  const recordStale = record && record.revision !== revision

  return <Card
    title={<Space wrap><b>{track.name}分谱</b><Tag color="blue">出版候选</Tag><span className="muted">{candidate.author} · {candidate.submittedAt} 回传</span></Space>}
    extra={<Space wrap>
      <Tag>回传基线 r{candidate.baseRevision}</Tag><Tag color="geekblue">现行基线 r{revision}</Tag>
      {baselineMoved && <Tag color="orange">基线已变化 · 已按新基线重算</Tag>}
      {transpositionMoved && <Tag color="purple">移调 {candidate.baselineTransposition} → {track.transposition} · 已重算</Tag>}
    </Space>}
    style={{ marginBottom: 16 }}
  >
    <div className="handoff-grid">
      <section>
        <h4>单边修改 · 直接并入（{result.noteChanges.length}）</h4>
        {result.noteChanges.length === 0 && <p className="muted">无单边修改</p>}
        {result.noteChanges.map((change) => <div className="diff-row" key={change.noteId}>
          <Tag color="green">已并入</Tag>
          <span>{change.noteId}：{change.kind === 'removed' ? `删除 ${describeNote(change.before)}` : change.kind === 'added' ? `新增 ${describeNote(change.after)}` : diffNoteFields(change.before!, change.after!).join('；')}</span>
        </div>)}
        {result.commentChanges.map((change) => <div className="diff-row" key={change.commentId}>
          <Tag color="green">评论锚点</Tag>
          <span>第 {change.anchor} 小节 · {change.commentId}：{change.after.resolved && !change.before.resolved ? '标记已解决' : '内容更新'}</span>
        </div>)}

        <h4 style={{ marginTop: 16 }}>两边都改过 · 保留双方待处置（{result.noteConflicts.length + result.commentConflicts.length}）</h4>
        {result.noteConflicts.length + result.commentConflicts.length === 0 && <p className="muted">无冲突，可直接并入</p>}
        {result.noteConflicts.map((conflict) => {
          const key = `${candidate.id}:${conflict.noteId}`
          return <div className="conflict-row" key={conflict.noteId}>
            <div><Tag color="red">冲突</Tag><b>{conflict.noteId}</b><small className="muted"> 基线：{describeNote(conflict.baseline)}</small></div>
            <div className="conflict-sides">
              <span>现行总谱：{describeNote(conflict.master)}</span>
              <span>回传内容：{describeNote(conflict.submitted)}</span>
              <Radio.Group size="small" value={resolutions[conflict.noteId]} onChange={(event) => dispatch(setResolution({ key, choice: event.target.value as ConflictChoice }))}>
                <Radio.Button value="master">保留现行</Radio.Button>
                <Radio.Button value="theirs">采用回传</Radio.Button>
              </Radio.Group>
            </div>
          </div>
        })}
        {result.commentConflicts.map((conflict) => {
          const key = `${candidate.id}:c:${conflict.commentId}`
          return <div className="conflict-row" key={conflict.commentId}>
            <div><Tag color="red">评论冲突</Tag><b>第 {conflict.anchor} 小节 · {conflict.commentId}</b></div>
            <div className="conflict-sides">
              <span>现行：{conflict.master ? `${conflict.master.resolved ? '已解决' : '未解决'} · ${conflict.master.content}` : '（已删除）'}</span>
              <span>回传：{conflict.submitted.resolved ? '已解决' : '未解决'} · {conflict.submitted.content}</span>
              <Radio.Group size="small" value={resolutions[`c:${conflict.commentId}`]} onChange={(event) => dispatch(setResolution({ key, choice: event.target.value as ConflictChoice }))}>
                <Radio.Button value="master">保留现行</Radio.Button>
                <Radio.Button value="theirs">采用回传</Radio.Button>
              </Radio.Group>
            </div>
          </div>
        })}
      </section>
      <aside>
        <h4>换页提示 · 按现行基线 r{revision} 重算</h4>
        {result.pageTurnHints.length === 0 && <p className="muted">本册暂无换页点</p>}
        {result.pageTurnHints.map((hint) => <div className="hint-row" key={hint.id}>
          <Tag color={hint.pendingReview ? 'orange' : 'blue'}>第 {hint.afterMeasure} 小节后换页</Tag>
          <span>提示音 {hint.cueMeasures} 小节 · {hint.note}</span>
          {hint.pendingReview && <Tag color="orange">待确认</Tag>}
        </div>)}
        <h4 style={{ marginTop: 16 }}>写盘记录</h4>
        {writeError && <Alert type="error" showIcon message={writeError} action={<Button size="small" icon={<ReloadOutlined />} onClick={() => dispatch(attemptPersist(candidate.id))}>重试写盘</Button>} style={{ marginBottom: 8 }} />}
        {record && !writeError && <div className="check-row">
          <span>{record.writtenAt} 写入 · 基线 r{record.revision} · {record.noteCount} 音 / {record.autoMerged} 并入 / {record.conflicts} 冲突</span>
          {recordStale ? <Tag color="orange">记录已失效</Tag> : <Tag color="green">记录最新</Tag>}
        </div>}
        {recordStale && <Button size="small" icon={<CloudUploadOutlined />} onClick={() => dispatch(attemptPersist(candidate.id))}>按新基线 r{revision} 重写记录</Button>}
        {!record && !writeError && <p className="muted">尚无写盘记录</p>}
        <Space style={{ marginTop: 16 }} wrap>
          <Popconfirm title="并入现行总谱" description="合并结果将写入总谱并形成新基线，可到版本页形成版本。" onConfirm={() => { const ok = dispatch(acceptCandidate(candidate.id)); if (ok) message.success(`${track.name}候选已并入现行总谱`); else message.warning('仍有未处置的冲突，无法并入') }}>
            <Button type="primary" disabled={unresolved > 0}>并入总谱{unresolved > 0 ? `（${unresolved} 处待处置）` : ''}</Button>
          </Popconfirm>
          <Button danger onClick={() => { dispatch(rejectCandidate(candidate.id)); message.info('已退回该回传，内容保留在已交声部日志中') }}>退回</Button>
        </Space>
      </aside>
    </div>
    {queued.length > 0 && <Alert style={{ marginTop: 12 }} type="warning" showIcon message={`同册后到 ${queued.length} 份 · 已留作冲突，不会静默覆盖`}
      description={queued.map((item) => `${item.author}（${item.submittedAt}）：与现行总谱差异 ${computeCandidate(item, track, comments, {}).noteChanges.length + computeCandidate(item, track, comments, {}).noteConflicts.length} 处，等待前序候选处置后晋升`).join('；')} />}
    {queued.length > 0 && <Button size="small" style={{ marginTop: 8 }} onClick={() => navigate('/versions')}>到版本页核对基线</Button>}
  </Card>
}

export default function Handoff() {
  const dispatch = useDispatch<AppDispatch>()
  const navigate = useNavigate()
  const tracks = useSelector((state: RootState) => state.score.tracks)
  const comments = useSelector((state: RootState) => state.score.comments)
  const revision = useSelector((state: RootState) => state.score.revision)
  const migrations = useSelector((state: RootState) => state.score.migrations)
  const submissions = useSelector((state: RootState) => state.handoff.submissions)
  const writeErrors = useSelector((state: RootState) => state.handoff.writeErrors)
  const recoveredIds = useSelector((state: RootState) => state.handoff.recoveredIds)
  const failNextWrite = useSelector((state: RootState) => state.handoff.failNextWrite)
  const persisted = useSelector((state: RootState) => state.handoff.persisted)

  const byTrack = useMemo(() => {
    const map = new Map<string, PartSubmission[]>()
    for (const submission of submissions) {
      if (submission.status !== 'returned') continue
      const list = map.get(submission.trackId) ?? []
      list.push(submission)
      map.set(submission.trackId, list)
    }
    return map
  }, [submissions])

  const summary = useMemo(() => {
    let conflicts = 0
    for (const [trackId, list] of byTrack) {
      const track = tracks.find((item) => item.id === trackId)
      const candidate = list[0]
      if (!track || !candidate) continue
      const result = computeCandidate(candidate, track, comments, {})
      conflicts += result.noteConflicts.length + result.commentConflicts.length
    }
    return { candidates: byTrack.size, queued: [...byTrack.values()].reduce((sum, list) => sum + list.length - 1, 0), conflicts }
  }, [byTrack, tracks, comments])

  const disposed = submissions.filter((item) => item.status !== 'returned')

  return <main className="page">
    <div className="page-head">
      <div><p className="eyebrow">离线校订交接</p><h1>回传、候选与冲突处置</h1><p>声部长带回的离线校订按音符标识与评论锚点同现行总谱比较：单边修改直接并入，两边都改过保留双方内容待处置；同册先到者为候选，后到内容留作冲突。</p></div>
      <Space><Tag color="geekblue">现行基线 r{revision}</Tag><Button icon={<HistoryOutlined />} onClick={() => navigate('/versions')}>版本与评论</Button></Space>
    </div>

    {migrations.length > 0 && <Alert type="success" closable showIcon message="旧稿已升级" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{migrations.map((item) => <li key={item}>{item}</li>)}</ul>} onClose={() => dispatch(dismissMigrations())} style={{ marginBottom: 12 }} />}
    {recoveredIds.length > 0 && <Alert type="warning" showIcon message={`写盘中断：已从已交声部恢复 ${recoveredIds.length} 册`} description="候选记录未写入的提交已按日志恢复，重试写盘按提交标识幂等写入，不会重复追加记录。" style={{ marginBottom: 12 }} />}

    <Row gutter={[14, 14]} className="metrics">
      <Col xs={24} sm={12} xl={6}><Card className="metric"><span>待处置候选</span><strong>{summary.candidates}</strong><small>每册取先到的回传</small></Card></Col>
      <Col xs={24} sm={12} xl={6}><Card className="metric"><span>冲突待处置</span><strong>{summary.conflicts}</strong><small>两边都改过，保留双方内容</small></Card></Col>
      <Col xs={24} sm={12} xl={6}><Card className="metric"><span>后到留作冲突</span><strong>{summary.queued}</strong><small>同册后到，不静默覆盖</small></Card></Col>
      <Col xs={24} sm={12} xl={6}><Card className="metric"><span>写盘待重试</span><strong>{Object.keys(writeErrors).length}</strong><small>已交声部 {submissions.length} 份在日志中</small></Card></Col>
    </Row>

    {tracks.map((track) => {
      const list = byTrack.get(track.id)
      if (!list?.length) return null
      return <CandidateCard key={track.id} track={track} candidate={list[0]!} queued={list.slice(1)} />
    })}
    {byTrack.size === 0 && <Card style={{ marginBottom: 16 }}><Empty description="暂无待处置的回传，可用下方模板模拟声部长回传" /></Card>}

    <Row gutter={[16, 16]}>
      <Col xs={24} xl={8}>
        <Card title="模拟声部长回传" extra={<span className="muted">以提交瞬间的总谱为基线</span>}>
          {revisionTemplates.map((template) => <div className="diff-row" key={template.id}>
            <Tag>{template.author}</Tag>
            <span>{template.summary}</span>
            <Button size="small" onClick={() => { const id = dispatch(submitRevision(template.id)); if (id) { const queued = (byTrack.get(template.trackId)?.length ?? 0) > 0; message.success(queued ? '同册已有候选，后到内容已留作冲突' : '回传已登记为出版候选') } }}>回传</Button>
          </div>)}
        </Card>
      </Col>
      <Col xs={24} xl={8}>
        <Card title="写盘与恢复">
          <div className="check-row"><span>模拟下次写盘失败</span><Switch checked={failNextWrite} onChange={(checked) => dispatch(setFailNextWrite(checked))} /></div>
          <p className="muted">回传先写已交声部日志，再写候选记录；写盘失败重试按提交标识幂等写入，不会重复追加。当前候选记录 {Object.keys(persisted).length} 条。</p>
          <Table
            rowKey="submissionId" size="small" pagination={false}
            dataSource={Object.values(persisted)}
            columns={[
              { title: '提交', dataIndex: 'submissionId' },
              { title: '写入基线', render: (_value, row) => <Tag color={row.revision === revision ? 'green' : 'orange'}>r{row.revision}{row.revision === revision ? '' : ' · 已失效'}</Tag> },
              { title: '提示', render: (_value, row) => `${row.pageTurnHints.length} 条` },
            ]}
          />
        </Card>
      </Col>
      <Col xs={24} xl={8}>
        <Card title="旧稿升级与原出版版本">
          <p className="muted">旧稿没有声部标识时，按现有顺序回填标识并升级为 v2 结构；旧稿中的原出版版本并入版本列表，仍可查回。</p>
          <Space wrap>
            <Button onClick={() => { dispatch(loadLegacyDraftSample()); message.success('旧稿已按现有顺序回填升级，原出版版本可在版本页查回') }}>载入旧稿样例并升级</Button>
            <Button onClick={() => navigate('/versions')}>查看原出版版本</Button>
          </Space>
          {disposed.length > 0 && <>
            <h4 style={{ marginTop: 16 }}>已处置回传</h4>
            {disposed.map((item) => <div className="diff-row" key={item.id}>
              <Tag color={item.status === 'merged' ? 'green' : 'red'}>{item.status === 'merged' ? '已并入' : '已退回'}</Tag>
              <span>{item.trackName} · {item.author}</span>
              <small className="muted">{item.submittedAt}</small>
            </div>)}
          </>}
        </Card>
      </Col>
    </Row>
  </main>
}
