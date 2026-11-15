/** 投稿窗(点开才下载)。须知每次都要自己勾,不替人先勾。投插件的窗在 SubmitPluginDialog.tsx */
import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import { Dialog, CloseX, PanelsMissing, openAccount, openShareDialog, type SubmitView } from './AccountDialogs';
import { cleanSignature } from '../gen/savefile';
import { useSession } from '../account/session';
import type { SmallWork, SubmitForm, SubmitKind, SubmitLimits } from '../account/submissions';
import { rulesHash } from '../gen/civ/ruleShare';
import { useContact } from './contact';
import { pairText } from './fullWorldView';
import { momentNow } from './shareMoment';
import { currentSave, currentWorld, loadWorld } from './saveStore';
import { mapName } from './mapGroups';
import { presetHash } from './presetLink';
import { strip } from './presetStore';
import { modifiedCount } from './rules/rulesView';
import { TERMS, TERMS_VERSION, changedSince } from './submitTerms';
import { WORK_KIND_LABEL, askPhone, banWhole, keepLastBy, lastBy, submitBan, useSubmitBan, useSubmitJob, workKey, type SubmitBan, type SubmitWork } from './submitView';
import { askLimits, cancelSubmit, clearSubmitResult, holdSubmitToasts, resumeSubmit, saveToFile, startSubmit, useSubmitResult } from './submitFlow';
import { agreedTerms, draftOf, keepDraft, type Draft } from './submitDrafts';
import { notSubmitted, openNotice, type FailAct, type SubmitFail, type SubmitField } from './submitWords';
import { drawWorkThumb } from './submitThumbs';
import './submit.css';

const TITLE_MAX = 20;
const BY_MAX = 20;
const BLURB_MAX = 40;
const SHOW = '作品还是你的。投稿等于允许我们在作品墙上展示它：谁都能打开看、另存一份接着改、用它新建世界；另存的那份写着你的署名和出处。';

/** 交的是什么:上面那块的样子、作品名先填什么、点「投稿」怎么交 */
interface WorkSpec {
  /** 填的字按它记(一件作品一份),也是投稿结果、进度对应的那一件 */
  key: string;
  kind: SubmitKind;
  name: string;
  note: string;
  thumb: string | null;
  defaultTitle: string;
  send: (form: SubmitForm, thumb: string | null) => void;
}

function worldSpec(worldId: string, title: string): WorkSpec {
  const m = currentWorld()?.id === worldId ? momentNow(false) : null;
  const y = m?.moment.year;
  const moment = typeof y === 'number' && y >= 0 ? Math.floor(y) : null;
  return {
    key: worldId,
    kind: 'world',
    name: title || '未命名世界',
    note: `${m ? `停在${m.year}，封面照这一年的地图画。` : ''}交的是现在这一份，之后再改，作品墙上的不会跟着变。`,
    thumb: loadWorld(worldId)?.thumb ?? null,
    defaultTitle: title,
    send: (form, thumb) => void startSubmit({ id: worldId, kind: 'world', title: title || '未命名世界', form, moment, thumb }),
  };
}

/** 地图、新建参数、规则:点一下就交上去 */
function smallSpec(o: Omit<WorkSpec, 'send'>, work: (form: SubmitForm) => SmallWork | null): WorkSpec {
  return {
    ...o,
    send: (form, thumb) => {
      const w = work(form);
      if (w) void startSubmit({ id: o.key, kind: o.kind, title: form.title, form, moment: null, small: w, thumb });
    },
  };
}

type WorkOf = Exclude<SubmitWork, { kind: 'plugin' }>;

function specOf(work: WorkOf): WorkSpec {
  const key = workKey(work);
  if (work.kind === 'world') return worldSpec(work.worldId, work.title);
  if (work.kind === 'map') {
    const stored = loadWorld(work.worldId);
    const name = stored ? mapName(stored) : work.title;
    return smallSpec(
      { key, kind: 'map', name, note: '交的是这张地图，封面是它的实景图。之后再改，作品墙上的不会跟着变。', thumb: stored?.mapThumb ?? stored?.thumb ?? null, defaultTitle: name },
      () => {
        const save = (currentWorld()?.id === work.worldId ? currentSave() : null) ?? loadWorld(work.worldId)?.save;
        return save ? { kind: 'map', save } : null;
      },
    );
  }
  if (work.kind === 'preset') {
    const r = work.rules;
    return smallSpec(
      { key, kind: 'preset', name: work.name || '这套参数', note: `交的是这套参数${r ? `，连着规则「${r.name}」` : ''}。封面是用它长出来的星球。`, thumb: null, defaultTitle: work.name },
      (form) => ({
        kind: 'preset',
        link: presetHash({ name: form.title, params: strip(work.params), seed: work.params.seed, ...(work.endYear ? { endYear: work.endYear } : {}), ...(r ? { rules: r } : {}) }).replace(/^#/, ''),
      }),
    );
  }
  const n = modifiedCount(work.rules).total;
  return smallSpec(
    { key, kind: 'rules', name: work.rules.name, note: `交的是这套规则现在的样子${n ? `，改了 ${n} 项` : ''}。封面是用它在示例地图上推到第 3000 年的政区图。`, thumb: null, defaultTitle: work.rules.name },
    () => ({ kind: 'rules', link: rulesHash(work.rules).replace(/^#/, '') }),
  );
}

const seg = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'grapheme' }) : null;
export const chars = (s: string): string[] => (seg ? Array.from(seg.segment(s), (x) => x.segment) : [...s]);
export const clip = (s: string, max: number) => {
  const c = chars(s);
  return c.length > max ? c.slice(0, max).join('') : s;
};

// ---------------------------------------------------------------------------

const PluginSubmit = lazy(() => import('./SubmitPluginDialog').catch(() => ({ default: PanelsMissing as unknown as typeof import('./SubmitPluginDialog').default })));

export default function SubmitDialog({ phone, work, view, onClose }: { phone: boolean; work: SubmitWork; view?: SubmitView; onClose: () => void }) {
  if (work.kind !== 'plugin') return <WorkSubmitDialog phone={phone} work={work} view={view} onClose={onClose} />;
  return (
    <Suspense fallback={null}>
      <PluginSubmit phone={phone} work={work} onClose={onClose} />
    </Suspense>
  );
}

function WorkSubmitDialog({ phone, work, view, onClose }: { phone: boolean; work: WorkOf; view?: SubmitView; onClose: () => void }) {
  const [spec] = useState(() => specOf(work));
  // 新建参数、规则没有现成的小图:现画一张(后台线程算),画好换上
  const [thumb, setThumb] = useState(spec.thumb);
  useEffect(() => {
    if (spec.thumb) return;
    let live = true;
    void drawWorkThumb(work).then((t) => live && t && setThumb(t));
    return () => {
      live = false;
    };
  }, []);
  // 窗里说过的结果关了窗口就不再说(断线的再点「投稿」接着传,传过的块不用重传);关着时出来的提示条上只说了一句,打开时说全
  useEffect(() => () => clearSubmitResult(spec.key), [spec.key]);
  const session = useSession();
  useEffect(() => holdSubmitToasts(), []);

  const [form, setForm] = useState<Draft>(() => draftOf(spec.key) ?? { title: clip(spec.defaultTitle, TITLE_MAX), by: clip(lastBy(), BY_MAX), blurb: '' });
  const [checked, setChecked] = useState(false);
  const [agreed] = useState(agreedTerms);
  const [changed, setChanged] = useState<number[]>(() => (agreed !== null && agreed < TERMS_VERSION ? changedSince(agreed) : []));
  const [termsOpen, setTermsOpen] = useState(changed.length > 0);
  const [limits, setLimits] = useState<SubmitLimits | null>(null);
  const cachedBan = useSubmitBan();
  const [notice, setNotice] = useState<SubmitFail | null>(() => (view && submitBan() ? { kind: 'notice', which: 'ban', ban: submitBan()! } : null));
  const [bad, setBad] = useState<SubmitField[]>([]);
  const job = useSubmitJob();
  const mine = job?.id === spec.key ? job : null;
  const result = useSubmitResult(spec.key);

  useEffect(() => {
    let live = true;
    void askLimits().then(
      (r) => {
        if (!live) return;
        setLimits(r.limits);
        const n = openNotice({ limits: r.limits, ban: submitBan() });
        if (view === 'ban-share' && !submitBan() && work.kind === 'world') return openShareDialog(work.worldId, work.title);
        if (n && !mine && (view !== 'ban-share' || n.which === 'ban')) setNotice(n);
        else if (!n && view) setNotice(null);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  // 没投成的结果(这个窗开着、或者关了以后出来的)落到窗里
  const fail = result?.kind === 'fail' ? result.fail : null;
  useEffect(() => {
    if (!fail) return;
    void askLimits().then((r) => setLimits(r.limits), () => {});
    if (fail.kind === 'notice') setNotice(fail);
    if (fail.kind === 'terms') {
      setChanged(changedSince(TERMS_VERSION - 1));
      setTermsOpen(true);
      setChecked(false);
    }
    if (fail.kind === 'hits') setBad(fail.fields);
    if (fail.kind === 'phone') askPhone({ for: 'submit', then: () => clearSubmitResult(spec.key) });
  }, [fail]);

  const set = (k: keyof Draft, v: string, max: number) => {
    const next = { ...form, [k]: clip(v, max) };
    setForm(next);
    keepDraft(spec.key, next);
    if (bad.includes(k)) setBad(bad.filter((x) => x !== k));
  };
  const clean = { title: cleanSignature(form.title, TITLE_MAX), by: cleanSignature(form.by, BY_MAX), blurb: cleanSignature(form.blurb, BLURB_MAX) };
  const filled = !!clean.title && !!clean.by && !!clean.blurb;
  const busy = !!job;
  const netFail = !mine && fail?.kind === 'net';
  const dim = !!mine || netFail;
  const canSubmit = filled && checked && !busy;

  const submit = () => {
    if (!canSubmit) return;
    keepLastBy(clean.by);
    setBad([]);
    spec.send({ ...clean, terms: TERMS_VERSION }, thumb);
  };
  const failAct = (a: FailAct) => {
    if (a === 'retry') return submit();
    if (a === 'reload') return location.reload();
    onClose();
    saveToFile(spec.key);
  };

  if (!session) return null;
  if (result?.kind === 'done') return <DoneNotice phone={phone} left={result.left} email={session.user.account} onClose={onClose} />;
  if (notice?.kind === 'notice') return <LimitNotice phone={phone} fail={notice} ban={notice.ban ?? cachedBan} onClose={onClose} />;

  const block = fail && !mine && (fail.kind === 'hits' || fail.kind === 'block') ? fail : null;
  const line = fail && !mine && fail.kind === 'line' ? fail.text : null;
  const world = spec.kind === 'world';
  const left = mine && world ? '关掉窗口也会接着传' : netFail ? '' : limits ? `今天还能投 ${Math.max(0, limits.perDay - limits.usedToday)} 次` : '';
  const primary = mine || netFail ? '正在投稿' : block ? ACT_LABEL[block.kind === 'hits' ? 'retry' : block.act] : '投稿';
  const onPrimary = block && block.kind === 'block' ? () => failAct(block.act) : submit;
  const primaryOff = mine || netFail ? true : block?.kind === 'block' && block.act !== 'retry' ? false : !canSubmit;

  const n = (s: string) => chars(s).length;
  /** 一栏的即时校验三态:默认(空,不写) → 校验失败(红字) → 校验通过(绿字);手机上也看得见,读屏靠 aria-describedby 连上 */
  const hintId = (k: SubmitField) => `submit-hint-${k}`;
  const stateOf = (k: SubmitField, ok: boolean): 'idle' | 'bad' | 'ok' => (bad.includes(k) ? 'bad' : ok ? 'ok' : 'idle');
  const field = (label: string, side: string, input: ReactNode, k: SubmitField, ok: boolean) => {
    const st = stateOf(k, ok);
    return (
      <div className="sub-f">
        <div className="lab">
          {label}
          <small>{side}</small>
        </div>
        {input}
        {st !== 'idle' && (
          <p id={hintId(k)} className={st === 'bad' ? 'acct-err' : 'acct-okl'} role="status">
            {st === 'bad' ? '这一栏还差一点，改好再投' : '这一栏填好了'}
          </p>
        )}
      </div>
    );
  };
  const inCls = (k: SubmitField) => `acct-in${bad.includes(k) ? ' bad' : ''}`;
  /** 有提示才把输入框和那行字连起来(aria-describedby),没有提示就不给 */
  const ariaOf = (k: SubmitField, ok: boolean) => ({ 'aria-invalid': bad.includes(k) || undefined, 'aria-describedby': stateOf(k, ok) === 'idle' ? undefined : hintId(k) });
  const titleIn = field(
    '作品名',
    `${n(form.title)} / ${TITLE_MAX}`,
    <input className={inCls('title')} data-act="submit-title" aria-label="作品名" {...ariaOf('title', !!clean.title)} value={form.title} disabled={dim} onChange={(e) => set('title', e.target.value, TITLE_MAX)} />,
    'title',
    !!clean.title,
  );
  const byIn = field(
    '署名',
    phone ? '用笔名就行' : '作品墙上显示，用笔名就行',
    <input className={inCls('by')} data-act="submit-by" aria-label="署名" {...ariaOf('by', !!clean.by)} value={form.by} disabled={dim} onChange={(e) => set('by', e.target.value, BY_MAX)} />,
    'by',
    !!clean.by,
  );
  const blurbIn = field(
    '一句话介绍',
    `${n(form.blurb)} / ${BLURB_MAX}`,
    <textarea className={inCls('blurb')} data-act="submit-blurb" aria-label="一句话介绍" {...ariaOf('blurb', !!clean.blurb)} placeholder="说说它特别在哪" rows={2} value={form.blurb} disabled={dim} onChange={(e) => set('blurb', e.target.value.replace(/\n/g, ''), BLURB_MAX)} />,
    'blurb',
    !!clean.blurb,
  );

  // 地图、新建参数、规则一下就交上去了,不出进度那一行
  const prog = mine && world ? (
    <JobRow
      icon={mine.phase === 'check' ? <span className="sub-spin" aria-hidden="true" /> : <Icon name="cloudup" size={19} />}
      title={mine.phase === 'check' ? '正在核对' : `正在传「${mine.title}」`}
      small={mine.phase === 'check' ? '已经传完，服务器在检查里面的内容' : `${mine.phase === 'send' && mine.total ? `${pairText(mine.done, mine.total)}，` : ''}别关页面`}
      pct={mine.phase === 'send' && mine.total ? (mine.done / mine.total) * 100 : mine.phase === 'pack' ? 0 : null}
      act={mine.phase === 'check' ? null : { label: '取消', name: 'submit-row-cancel', on: cancelSubmit }}
    />
  ) : netFail ? (
    <JobRow icon={<Icon name="warn" size={19} className="wn" />} title="传到一半断线了" small="世界在本机没事，传上去的不用重传" pct={null} act={{ label: '接着传', name: 'submit-resume', on: () => resumeSubmit(spec.key) }} />
  ) : null;

  const foot = phone ? (
    <div className="acct-foot col">
      <button className="acct-btn full blue" data-act="submit-go" disabled={primaryOff} onClick={onPrimary}>
        {primary}
      </button>
      {left && (
        <span className="acct-small center" style={{ marginTop: 2 }}>
          {left}
        </span>
      )}
    </div>
  ) : (
    <div className="acct-foot">
      <span className="acct-small">{left}</span>
      <span className="acct-sp" />
      <button className="acct-btn" data-act="submit-close" onClick={onClose}>
        {(mine && world) || netFail ? '关掉' : '取消'}
      </button>
      <button className="acct-btn blue" data-act="submit-go" disabled={primaryOff} onClick={onPrimary}>
        {primary}
      </button>
    </div>
  );

  return (
    <Dialog phone={phone} label="投到作品墙" width={termsOpen ? 560 : 500} onClose={onClose} testId="submit-dialog">
      <div className="acct-body" style={{ gap: phone ? 12 : 14 }}>
        <div className="sub-what">
          {thumb ? <img className="sub-th" src={thumb} alt="" draggable={false} /> : <span className="sub-th" />}
          <span className="main">
            <span className="t1">
              <span className="sub-k">{WORK_KIND_LABEL[spec.kind]}</span>
              <b>{spec.name}</b>
            </span>
            <small>{spec.note}</small>
          </span>
        </div>
        {phone ? (
          <div className="sub-col">
            {titleIn}
            {byIn}
          </div>
        ) : (
          <div className="sub-row2">
            {titleIn}
            {byIn}
          </div>
        )}
        {blurbIn}
        {block && <FailBlock fail={block} kind={spec.kind} />}
        <div className={`acct-callout sub-show${dim ? ' sub-dim' : ''}`}>
          <Icon name="info" size={16} />
          <span>{SHOW}</span>
        </div>
        {changed.length > 0 && (
          <div className="acct-callout sub-warn" data-testid="submit-terms-changed">
            <Icon name="warn" size={16} />
            <span>
              <b>投稿须知改过了</b>
              <span className="sub">，第 {changed.map((i) => i + 1).join('、')} 条变了（标出来的那句）。看过再勾上。</span>
            </span>
          </div>
        )}
        {termsOpen && (
          <div className="sub-terms" data-testid="submit-terms">
            <div className="hd">
              投稿须知<small>第 {TERMS_VERSION} 版</small>
            </div>
            <ol className="gl-ol">
              {TERMS.map((t, i) => (
                <li key={i}>
                  {changed.includes(i) ? (
                    <>
                      <span className="sub-chg">{t}</span>
                      <span className="sub-chg-tag">改了</span>
                    </>
                  ) : (
                    t
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
        <label className={`acct-chk${dim ? ' sub-dim' : ''}`}>
          <input type="checkbox" data-act="submit-agree" checked={checked} disabled={dim} onChange={(e) => setChecked(e.target.checked)} />
          <i className="b" aria-hidden="true">
            {checked && <Icon name="check" size={12} />}
          </i>
          <span>
            我看过
            <button type="button" className="sub-link" data-act="submit-terms" onClick={(e) => (e.preventDefault(), setTermsOpen((o) => !o))}>
              投稿须知
            </button>
            {termsOpen ? '' : '（5 条）'}
          </span>
        </label>
        {prog}
        {line && <p className="acct-err">{line}</p>}
      </div>
      {foot}
    </Dialog>
  );
}

export const ACT_LABEL: Record<FailAct, string> = { retry: '再投一次', reload: '刷新页面', file: '存成文件' };

function JobRow({ icon, title, small, pct, act }: { icon: ReactNode; title: string; small: string; pct: number | null; act: { label: string; name: string; on: () => void } | null }) {
  return (
    <div className="acct-grp sub-prog" data-testid="submit-progress">
      <div className="acct-gr">
        {icon}
        <span className="main">
          <b>{title}</b>
          <small>{small}</small>
          {pct !== null && (
            <i className="acct-bar">
              <i style={{ width: `${Math.round(pct)}%` }} />
            </i>
          )}
        </span>
        {act && (
          <button className="mini" data-act={act.name} onClick={act.on}>
            {act.label}
          </button>
        )}
      </div>
    </div>
  );
}

export function FailBlock({ fail, kind }: { fail: Extract<SubmitFail, { kind: 'hits' | 'block' }>; kind: SubmitKind }) {
  return (
    <div className="acct-callout sub-bad" data-testid="submit-fail">
      <Icon name="warn" size={16} />
      {fail.kind === 'block' ? (
        <span>
          {fail.head && <b>{fail.head}</b>}
          {fail.text}
        </span>
      ) : (
        <span>
          <b>{notSubmitted(kind)}。</b>
          {fail.one ?? `下面 ${fail.count} 处没通过文字审核，改掉再投：`}
          {!fail.one && (
            <ul className="sub-hits">
              {fail.lines.map((l, i) => (
                <li key={i}>
                  {l.label}
                  <span>{l.text}</span>
                </li>
              ))}
            </ul>
          )}
          <span className="sub sub-again">改完再点「投到作品墙…」，这里填的字会留着。</span>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 通知样子的窗口:投好了、投不了

const CLOCK = (
  <svg className="icon" width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export function Notice({ phone, icon, tone, h, p, why, small, btns, onClose, testId }: { phone: boolean; icon: IconName | 'clock'; tone?: string; h: string; p: string; why?: ReactNode; small?: string; btns: ReactNode; onClose: () => void; testId: string }) {
  return (
    <Dialog
      phone={phone}
      label={h}
      width={420}
      onClose={onClose}
      testId={testId}
      head={
        <div className="acct-head" style={{ paddingBottom: 0 }}>
          <span style={{ flex: 1 }} />
          <CloseX onClose={onClose} />
        </div>
      }
    >
      <div className="gw-ok" style={{ paddingTop: 4 }}>
        <span className={`gw-ok-ic${tone ? ` ${tone}` : ''}`}>{icon === 'clock' ? CLOCK : <Icon name={icon} size={28} />}</span>
        <h2>{h}</h2>
        <p>{p}</p>
        {why && <div className="sub-why">{why}</div>}
        {small && <p className="acct-small">{small}</p>}
      </div>
      <div className={`acct-foot${phone ? ' col' : ''}`}>{btns}</div>
    </Dialog>
  );
}

export function NoticeBtn({ phone, blue, children, onClick, act }: { phone: boolean; blue?: boolean; children: ReactNode; onClick: () => void; act: string }) {
  return (
    <button className={`acct-btn ${phone ? 'full' : 'lg gw-wide'}${blue ? ' blue' : phone ? ' sub-plain' : ''}`} data-act={act} onClick={onClick}>
      {children}
    </button>
  );
}

export function DoneNotice({ phone, left, email, onClose }: { phone: boolean; left: number | null; email: string; onClose: () => void }) {
  return (
    <Notice
      phone={phone}
      icon="check"
      h="投好了"
      p={`我们看过以后，会放上作品墙，或者告诉你为什么没放。结果发邮件到 ${email}，也能在账号窗的「我的投稿」里看。`}
      small={`没审之前，在「我的投稿」里能撤回。${left !== null ? `今天还能投 ${left} 次。` : ''}`}
      testId="submit-done"
      onClose={onClose}
      btns={
        <>
          <NoticeBtn phone={phone} act="submit-look" onClick={() => openAccount('submissions')}>
            看我的投稿
          </NoticeBtn>
          <NoticeBtn phone={phone} blue act="submit-ok" onClick={onClose}>
            好
          </NoticeBtn>
        </>
      }
    />
  );
}

export function LimitNotice({ phone, fail, ban, onClose }: { phone: boolean; fail: Extract<SubmitFail, { kind: 'notice' }>; ban: SubmitBan | null; onClose: () => void }) {
  const contact = useContact();
  const look = (
    <NoticeBtn phone={phone} act="submit-look" onClick={() => openAccount('submissions')}>
      看我的投稿
    </NoticeBtn>
  );
  const ok = (blue: boolean) => (
    <NoticeBtn phone={phone} blue={blue} act="submit-ok" onClick={onClose}>
      知道了
    </NoticeBtn>
  );
  if (fail.which === 'ban')
    return (
      <Notice
        phone={phone}
        icon="ban"
        tone="sub-grey"
        h="你的账号已停止投稿"
        p="投稿和开分享链接都停了，已经开的分享链接也暂停了。登录、传到账号、存成文件照常。"
        why={
          ban?.reasonText ? (
            banWhole(ban) ? (
              ban.reasonText
            ) : (
              <>
                <b>原因：</b>
                {ban.reasonText}
              </>
            )
          ) : undefined
        }
        small="觉得弄错了，请到 QQ 交流群联系我们。"
        testId="submit-banned"
        onClose={onClose}
        btns={
          <>
            {ok(false)}
            {contact && (
              <a className={`acct-btn blue ${phone ? 'full' : 'lg gw-wide'}`} href={contact.url} target="_blank" rel="noreferrer" data-link="contact">
                <Icon name="bubble" size={phone ? 17 : 16} />
                加交流群
              </a>
            )}
          </>
        }
      />
    );
  const perDay = fail.limits?.perDay ?? 3;
  const pendingMax = fail.limits?.pendingMax ?? 5;
  if (fail.which === 'per-day')
    return (
      <Notice
        phone={phone}
        icon="info"
        tone="sub-blue"
        h={`今天投满 ${perDay} 次了`}
        p={`每个账号每天最多投 ${perDay} 次，明天再来。世界在本机没事。`}
        small="「明天」从北京时间 0 点算。"
        testId="submit-per-day"
        onClose={onClose}
        btns={
          <>
            {look}
            {ok(true)}
          </>
        }
      />
    );
  return (
    <Notice
      phone={phone}
      icon="info"
      tone="sub-blue"
      h={`等审的已经有 ${pendingMax} 件了`}
      p={`同时最多等 ${pendingMax} 件。等我们审完一件，或者在「我的投稿」里撤回一件，就能再投。`}
      testId="submit-pending"
      onClose={onClose}
      btns={
        <>
          {look}
          {ok(true)}
        </>
      }
    />
  );
}
