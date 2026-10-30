// 大纲与剧本：两份文本产物整份可读。大纲看改编说明、人物、爽点、分集；剧本按集看场次与节拍流（动作 / 台词）。
// 页签与选中的集记在网址里（?tab=script&ep=…），全貌页的阶段卡可以直接链过来。
import { useParams, useSearchParams } from 'react-router';
import { projectPath, useApi } from '../api.ts';
import { Badge, cardClass, Empty, ErrorView, Loading, PageHead, Segmented } from '../components/ui.tsx';
import { epLabel, gateText, gateTone, joinDot, seconds } from '../format.ts';
import type { Choice, FlowItem, GateResult, OutlinePage, OutlineView, ScriptPage, ScriptView } from '../types.ts';
import s from './StoryPage.module.css';

type Tab = 'outline' | 'script';
type Episode = ScriptView['episodes'][number];
type Scene = Episode['scenes'][number];

function GateLine({ label, gates, v }: { label: string; gates: GateResult | null; v: number }) {
  return (
    <div className={s.gateLine}>
      <Badge tone={gateTone(gates)}>{gateText(label, gates)}</Badge>
      <span>当前版本 v{v}</span>
    </div>
  );
}

function Choices({ title, items }: { title: string; items: readonly Choice[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h3>{title}</h3>
      <ul className={s.choices}>
        {items.map((c, i) => (
          <li key={i}>
            <b>{c.what}</b>
            {c.why ? <span>{c.why}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Adaptation({ a }: { a: OutlineView['adaptation'] }) {
  return (
    <section className={`${cardClass} ${s.section}`} aria-label="改编说明">
      <h2>改编说明</h2>
      <p className={s.core}>{a.core || '—'}</p>
      <div className={s.choiceGrid}>
        <Choices title="保留" items={a.keep} />
        <Choices title="删减" items={a.cut} />
        <Choices title="合并" items={a.merge} />
        <Choices title="风险与对策" items={a.risks} />
      </div>
      {a.notes.map((n, i) => (
        <p key={i} className={s.note}>
          {n}
        </p>
      ))}
    </section>
  );
}

function Characters({ items }: { items: OutlineView['characters'] }) {
  return (
    <section className={`${cardClass} ${s.section}`} aria-label="人物表">
      <h2>人物表 · {items.length}</h2>
      <div className={s.rows}>
        {items.map((c) => (
          <div key={c.id} className={s.row}>
            <b>{c.name}</b>
            <span className={s.meta}>{joinDot(c.id, c.tier, c.role)}</span>
            <span>{c.arc || '—'}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Beats({ items }: { items: OutlineView['beats'] }) {
  return (
    <section className={`${cardClass} ${s.section}`} aria-label="爽点表">
      <h2>爽点表 · {items.length}</h2>
      <div className={s.rows}>
        {items.map((b) => (
          <div key={b.id} className={s.row}>
            <b>第 {b.episode} 集</b>
            <span className={s.meta}>
              <Badge tone={b.major ? 'warn' : 'idle'}>{b.type}</Badge>
            </span>
            <span>
              {b.setup} → {b.payoff}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SetPieces({ outline }: { outline: OutlineView }) {
  return (
    <section className={`${cardClass} ${s.section}`} aria-label="场景与道具">
      <h2>场景与道具</h2>
      <div className={s.rows}>
        {outline.scenes.map((x) => (
          <div key={x.id} className={s.row}>
            <b>{x.name}</b>
            <span className={s.meta}>{joinDot(x.id, x.primary ? '主场景' : '次场景')}</span>
            <span>{x.note || '—'}</span>
          </div>
        ))}
        {outline.props.map((p) => (
          <div key={p.id} className={s.row}>
            <b>{p.name}</b>
            <span className={s.meta}>{joinDot(p.id, '道具', p.beats.join('、'))}</span>
            <span>{p.function || '—'}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function OutlineEpisodes({ items }: { items: OutlineView['episodes'] }) {
  return (
    <section className={`${cardClass} ${s.section}`} aria-label="分集梗概">
      <h2>分集梗概 · {items.length} 集</h2>
      {items.map((e) => (
        <article key={e.id} className={s.episode} data-testid={`outline-ep-${e.ep}`}>
          <header>
            <b>第 {epLabel(e.ep)} 集</b>
            <span className={s.meta}>{joinDot(e.characters.join('、'), e.scenes.join('、'), e.props.join('、'))}</span>
          </header>
          <p>{e.synopsis}</p>
          <dl className={s.kv}>
            <dt>钩子</dt>
            <dd>{e.hook || '—'}</dd>
            <dt>悬念</dt>
            <dd>{e.suspense || '—'}</dd>
            {e.crowdPlan ? (
              <>
                <dt>群戏</dt>
                <dd>{e.crowdPlan}</dd>
              </>
            ) : null}
            {e.warnings.length ? (
              <>
                <dt>生成难点</dt>
                <dd className={s.warn}>{e.warnings.join('、')}</dd>
              </>
            ) : null}
          </dl>
        </article>
      ))}
    </section>
  );
}

function OutlineTab({ id }: { id: string }) {
  const v = useApi<OutlinePage>(projectPath(id, '/outline'));
  if (v.error) return <ErrorView error={v.error} onRetry={v.reload} />;
  if (!v.data) return <Loading what="读取大纲" />;
  const o = v.data.outline;
  if (!o) return <Empty title="大纲还没有">文本阶段跑完大纲后，这里显示改编说明、人物表、爽点表和分集梗概。</Empty>;
  return (
    <div className={s.stack}>
      <GateLine label="大纲" gates={v.data.gates} v={o.v} />
      <Adaptation a={o.adaptation} />
      <OutlineEpisodes items={o.episodes} />
      <div className={s.pair}>
        <Characters items={o.characters} />
        <Beats items={o.beats} />
      </div>
      <SetPieces outline={o} />
    </div>
  );
}

function Beat({ b }: { b: FlowItem }) {
  const hook = b.hook ? <Badge tone="run">钩子</Badge> : null;
  if (b.kind === 'action') {
    return (
      <p className={s.action}>
        {hook}
        {b.text}
      </p>
    );
  }
  return (
    <p className={s.line}>
      {hook}
      {b.speaker ? <b>{b.speaker}</b> : null}
      {b.delivery ? <span className={s.delivery}>（{b.delivery}）</span> : null}
      {b.speaker || b.delivery ? '：' : null}
      {b.text}
    </p>
  );
}

function SceneBlock({ sc }: { sc: Scene }) {
  return (
    <section className={s.scene} aria-label={`第 ${sc.n} 场`}>
      <header>
        <b>
          第 {sc.n} 场 · {sc.location}
        </b>
        <span className={s.meta}>{joinDot(sc.lighting, sc.characters.join('、'), sc.props.length ? `道具：${sc.props.join('、')}` : null)}</span>
      </header>
      {sc.flow.map((b) => (
        <Beat key={b.id} b={b} />
      ))}
    </section>
  );
}

function EpisodeScript({ e }: { e: Episode }) {
  return (
    <article className={`${cardClass} ${s.section}`} data-testid={`script-ep-${e.ep}`}>
      <header className={s.epHead}>
        <h2>第 {epLabel(e.ep)} 集</h2>
        <span className={s.meta}>{joinDot(e.targetSeconds ? `目标 ${seconds(e.targetSeconds)}` : null, `${e.scenes.length} 场 · ${e.lines} 句`, e.beatsClaimed.length ? `爽点：${e.beatsClaimed.join('、')}` : null)}</span>
      </header>
      <dl className={s.kv}>
        <dt>钩子</dt>
        <dd>{e.hook || '—'}</dd>
        <dt>结尾悬念</dt>
        <dd>{e.cliff || '—'}</dd>
      </dl>
      {e.scenes.map((sc) => (
        <SceneBlock key={sc.id} sc={sc} />
      ))}
    </article>
  );
}

function ScriptTab({ id, ep, onPick }: { id: string; ep: string | null; onPick: (id: string) => void }) {
  const v = useApi<ScriptPage>(projectPath(id, '/script'));
  if (v.error) return <ErrorView error={v.error} onRetry={v.reload} />;
  if (!v.data) return <Loading what="读取剧本" />;
  const script = v.data.script;
  if (!script) return <Empty title="剧本还没有">剧本阶段跑完后，这里按集显示场次、动作和台词。</Empty>;
  const chosen = script.episodes.find((e) => e.id === ep || String(e.ep) === ep) ?? script.episodes[0];
  return (
    <div className={s.stack}>
      <GateLine label="剧本" gates={v.data.gates} v={script.v} />
      <div className={s.scriptBody}>
        <nav className={`${cardClass} ${s.epList}`} aria-label="选集">
          {script.episodes.map((e) => (
            <button key={e.id} type="button" aria-current={e.id === chosen?.id} onClick={() => onPick(e.id)}>
              <b>第 {epLabel(e.ep)} 集</b>
              <small>{e.hook || `${e.scenes.length} 场`}</small>
            </button>
          ))}
        </nav>
        {chosen ? <EpisodeScript e={chosen} /> : <Empty title="剧本里没有分集" />}
      </div>
    </div>
  );
}

export function StoryPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'script' ? 'script' : 'outline';
  const go = (next: Record<string, string>) => setParams(next, { replace: true });
  return (
    <>
      <PageHead
        title="大纲与剧本"
        sub="来自 novel-outline 和 novel-script 的当前版本；要改请在全貌页打回对应阶段或集"
        actions={<Segmented label="查看" value={tab} onChange={(t) => go({ tab: t })} options={[{ value: 'outline', label: '大纲' }, { value: 'script', label: '剧本' }]} />}
      />
      {tab === 'outline' ? <OutlineTab id={id} /> : <ScriptTab id={id} ep={params.get('ep')} onPick={(ep) => go({ tab: 'script', ep })} />}
    </>
  );
}
