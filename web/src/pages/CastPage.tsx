// 角色与美术：大纲名单 + 角色卡（参考图待付费生成）、场景与道具；右侧看选中角色的形象、音色、出场统计与提示词。
import { Box, Mountain, User, Volume2, X } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { api, ApiError, projectPath, useApi } from '../api.ts';
import { Badge, Button, ButtonHint, cardClass, ErrorView, Loading, PageHead, Segmented, useToast } from '../components/ui.tsx';
import o from '../components/overview.module.css';
import type { CastView, CharacterView, GateResult } from '../types.ts';
import s from './CastPage.module.css';

const gateText = (label: string, g: GateResult | null) =>
  !g ? `${label}还没有` : g.total !== null ? `${label}质量门 ${g.passed}/${g.total}` : g.failed.length ? `${label} ${g.failed.length} 处违规` : `${label}质量门通过`;
const gateTone = (g: GateResult | null) => (!g ? 'idle' : g.failed.length ? 'err' : 'ok') as 'idle' | 'err' | 'ok';

function CharacterPanel({ c, projectId, onClose, onDone, onError }: { c: CharacterView; projectId: string; onClose: () => void; onDone: (m: string) => void; onError: (e: ApiError) => void }) {
  const [showPrompt, setShowPrompt] = useState(false);
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const reject = async () => {
    try {
      await api.post(projectPath(projectId, '/reject'), { stage: 'cast', note: `${c.name}（${c.id}）：${note}` });
      onDone(`已打回角色卡，正在重跑（只改${c.name}）`);
      setRejecting(false);
    } catch (e) {
      onError(e as ApiError);
    }
  };
  const card = c.card;
  return (
    <aside className={`${cardClass} ${s.panel}`} aria-label="角色详情">
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <h2>{c.name}</h2>
          <span className={s.panelMeta}>{[c.id, c.tier, card?.ageRange, card?.identity].filter(Boolean).join(' · ')}</span>
        </div>
        <button type="button" className={o.iconBtn} aria-label="关闭" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {c.drawn ? (
        <div>
          <h3>参考图 · 先出锚点，其余只参考锚点</h3>
          <div className={s.views}>
            {['正面全身', '大头照', '90° 侧面', '背面', '细节'].map((v) => (
              <div key={v}>
                <div />
                {v}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className={s.p}>功能角色不出图（只闻其声或一闪而过）。</p>
      )}
      {card ? (
        <>
          <div>
            <h3>形象</h3>
            <p className={s.p}>{card.appearance || '—'}</p>
          </div>
          {card.personality.length ? (
            <div>
              <h3>性格</h3>
              <div className={s.tags}>
                {card.personality.map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
            </div>
          ) : null}
          <div>
            <h3>音色</h3>
            <p className={s.p}>{card.voice || '—'}</p>
          </div>
        </>
      ) : (
        <p className={s.p}>大纲里有这个角色，但角色卡里还没有他的卡片。</p>
      )}
      <div className={s.counts}>
        {[
          ['出场', `${c.usage.episodes} 集 · ${c.usage.scenes} 场`],
          ['分镜', `${c.usage.cuts} 切`],
          ['台词', `${c.usage.lines} 句`],
        ].map(([k, v]) => (
          <div key={k} className={o.metric}>
            <small>{k}</small>
            <b style={{ fontSize: 14 }}>{v}</b>
          </div>
        ))}
      </div>
      {showPrompt && card ? <pre className={s.prompt}>{`形象提示词\n${card.imagePrompt}\n\n设定图版面\n${card.sheet}\n\n音色提示词\n${card.voicePrompt}`}</pre> : null}
      {rejecting ? <textarea className={o.note} aria-label="角色卡修改意见" placeholder="例如：年龄改成二十出头，旗袍换成学生装" value={note} onChange={(e) => setNote(e.target.value)} /> : null}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 'auto' }}>
        {rejecting ? (
          <>
            <Button onClick={() => setRejecting(false)}>取消</Button>
            <Button variant="dark" disabled={!note.trim()} onClick={() => void reject()}>
              打回角色卡
            </Button>
          </>
        ) : (
          <>
            <Button disabled={!card} onClick={() => setShowPrompt((v) => !v)}>
              {showPrompt ? '收起提示词' : '查看完整提示词'}
            </Button>
            <Button variant="dark" onClick={() => setRejecting(true)}>
              附意见打回角色卡
            </Button>
          </>
        )}
      </div>
    </aside>
  );
}

export function CastPage() {
  const { id = '' } = useParams();
  const v = useApi<CastView>(projectPath(id, '/cast'));
  const [tab, setTab] = useState<'all' | 'scene' | 'prop'>('all');
  const [picked, setPicked] = useState<string | null>(null);
  const [toast, notify] = useToast();
  if (v.error) return <ErrorView error={v.error} onRetry={v.reload} />;
  if (!v.data) return <Loading what="读取角色与美术" />;
  const data = v.data;
  const scenes = data.art.filter((a) => a.kind === 'scene');
  const props = data.art.filter((a) => a.kind === 'prop');
  const chosen = data.characters.find((c) => c.id === picked) ?? data.characters[0] ?? null;
  const art = tab === 'all' ? data.art : data.art.filter((a) => a.kind === tab);
  const silent = data.characters.filter((c) => !c.drawn).map((c) => c.id);
  return (
    <>
      <PageHead
        title="角色与美术"
        sub="来自 novel-characters 和 novel-art；参考图要等付费生成后才有"
        actions={
          <>
            <Segmented
              label="筛选"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'all', label: `角色 ${data.characters.length}` },
                { value: 'scene', label: `场景 ${scenes.length}` },
                { value: 'prop', label: `道具 ${props.length}` },
              ]}
            />
            <Button variant="primary" disabled title="角色参考图在付费生成模块（Phase 5）生成">
              生成角色参考图 <ButtonHint>Phase 5</ButtonHint>
            </Button>
          </>
        }
      />
      <div className={s.body}>
        <div>
          {tab === 'all' ? (
            <>
              <div className={s.gateLine}>
                <Badge tone={gateTone(data.gates.cast)}>{gateText('角色卡', data.gates.cast)}</Badge>
                {data.characters.length} 个角色对上大纲{silent.length ? `；${silent.join('、')} 是功能角色，不出图` : ''}
              </div>
              <div className={s.chars}>
                {data.characters.map((c) => (
                  <button key={c.id} type="button" className={s.char} aria-current={c.id === chosen?.id} onClick={() => setPicked(c.id)}>
                    <div className={s.portrait}>
                      {c.drawn ? <User size={18} /> : <Volume2 size={18} />}
                      {c.drawn ? '待生成' : '不出图'}
                    </div>
                    <div>
                      <b>{c.name}</b>
                      <span className={s.code}>{c.id}</span>
                      <div>
                        <span className={`${s.tier} ${c.tier === '主角' ? s.tierLead : ''}`}>{c.role || c.tier}</span>
                      </div>
                      <div className={s.blurb}>{c.card?.oneLiner || c.card?.appearance || '还没有角色卡'}</div>
                      <div className={s.usage}>
                        出场 {c.usage.episodes} 集 · {c.usage.scenes} 场
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : null}
          <div className={s.sectionHead}>
            <h2>场景与道具</h2>
            <Badge tone={gateTone(data.gates.art)}>{gateText('美术', data.gates.art)}</Badge>
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>锚点让同一个场景跨集长一样；空景图同样等付费生成</span>
          </div>
          <div className={s.art}>
            {art.map((a) => (
              <div key={a.id} className={`${cardClass} ${s.item}`}>
                <div className={s.thumb}>{a.kind === 'scene' ? <Mountain size={16} /> : <Box size={16} />}</div>
                <b>{a.name}</b>
                <span className={s.code}>{a.id}</span>
                <small>{a.note}</small>
                <p>锚点：{a.anchors.join(' · ') || '—'}</p>
                <small style={{ marginTop: 4 }}>
                  {a.kind === 'scene' ? '光照' : '状态'}：{a.states.join(' / ') || '—'}
                </small>
              </div>
            ))}
          </div>
          {data.art.length === 0 ? <p style={{ color: 'var(--text-2)' }}>美术阶段还没有产物。</p> : null}
        </div>
        {chosen ? <CharacterPanel key={chosen.id} c={chosen} projectId={id} onClose={() => setPicked(null)} onDone={(m) => (notify(m), v.reload())} onError={(e) => notify(e.message, 'err')} /> : null}
      </div>
      {toast}
    </>
  );
}
