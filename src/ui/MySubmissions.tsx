/** 账号窗「我的投稿」(服务器开着投稿才有)。提示条盖不到账号窗,撤回、撤下的确认和没成的原因都写在那一行里 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { ServerError } from '../account/server';
import { cancelSubmission, fetchSubmissions, takedownSubmission, type Submission, type SubmitLimits } from '../account/submissions';
import { closeAccountPanel, errText } from './AccountDialogs';
import { dayText } from './Gallery';
import { openGalleryWork } from './newCivAction';
import { WORK_KIND_LABEL, readBan, setSubmitBan, useSubmitOn } from './submitView';
import { submitThumb } from './submitThumbs';
import { versionLabel } from './plugins/pluginWords';
import './submit.css';

const SHOW = 20;
const WAITING = new Set(['checking', 'pending', 'reviewing']);
/** 服务器写的「作者自己撤下」 */
const BY_AUTHOR = '作者自己撤下';

/** 最近 20 件,等审、审核中的再早也列着;投世界核对没过的(没收下)不列 */
export function shownSubmissions(list: readonly Submission[]): Submission[] {
  const kept = list.filter((s) => s.status !== 'failed');
  let room = SHOW - kept.filter((s) => WAITING.has(s.status)).length;
  return kept.filter((s) => WAITING.has(s.status) || room-- > 0);
}

export type RowAct = 'cancel' | 'look' | 'take';
export interface RowWords {
  st: 'wait' | 'ing' | 'up' | 'back' | 'off';
  label: string;
  text: string;
  acts: RowAct[];
}

const isToday = (iso: string | undefined, now: Date) => {
  const d = new Date(iso ?? '');
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
};

/** 一行的圆点、状态字、小字和按钮。phone:小字前面不写种类(省一行);插件一版一行,写第几版 */
export function rowWords(s: Submission, phone: boolean, now = new Date()): RowWords {
  const plugin = s.kind === 'plugin';
  const ver = plugin && s.plugin ? versionLabel(s.plugin.version) : '';
  const kind = plugin ? (phone ? (ver ? `${ver}，` : '') : `插件${ver}，`) : phone ? '' : `${WORK_KIND_LABEL[s.kind] ?? '作品'}，`;
  const day = (iso: string | undefined) => (isToday(iso, now) ? '今天' : dayText(iso ?? ''));
  const decided = s.decidedAt ?? s.updatedAt;
  switch (s.status) {
    case 'checking':
    case 'pending':
      return { st: 'wait', label: '等审', text: `${kind}${day(s.createdAt)}投的`, acts: ['cancel'] };
    case 'reviewing':
      return { st: 'ing', label: '审核中', text: `${kind}${day(s.createdAt)}投的`, acts: ['cancel'] };
    case 'live':
      return { st: 'up', label: '已上墙', text: `${kind}${day(decided)}上墙`, acts: s.workId ? ['look', 'take'] : ['take'] };
    case 'returned':
      return { st: 'back', label: '退回', text: `${plugin ? kind : ''}${dayText(decided ?? '')}。${s.reason ?? ''}`, acts: [] };
    case 'replaced':
      if (plugin) return { st: 'off', label: '已换下', text: `${kind}${day(s.updatedAt)}换成新版`, acts: [] };
      break;
    case 'disabled':
      if (plugin) return { st: 'off', label: '停用了', text: `${kind}${day(s.updatedAt)}停用${s.reason ? `：${s.reason}` : ''}`, acts: [] };
      break;
    case 'withdrawn': {
      if (s.reason === BY_AUTHOR) return { st: 'off', label: '已撤下', text: `${kind}${day(s.updatedAt)}你自己撤下的`, acts: [] };
      const reported = /^举报核实[:：]\s*(.+)$/.exec(s.reason ?? '')?.[1];
      const why = reported ? `被举报，核实是${reported}` : (s.reason ?? '');
      return { st: 'off', label: '已撤下', text: `${plugin ? kind : ''}${dayText(s.updatedAt ?? '')}撤下${why ? `：${why}` : ''}`, acts: [] };
    }
  }
  return { st: 'wait', label: '处理中', text: `${kind}${day(s.createdAt)}投的`, acts: [] };
}

const failText = (e: unknown) => (e instanceof ServerError && e.code === 'network' ? '连不上服务器，联网后再试' : errText(e));

export function MySubmissions({ phone, scrollTo }: { phone: boolean; scrollTo: boolean }) {
  const on = useSubmitOn(true);
  const [list, setList] = useState<Submission[] | null>(null);
  const [limits, setLimits] = useState<SubmitLimits | null>(null);
  /** 正在确认撤回 / 撤下的那一行;failed = 这次没成的原因(留在确认里给「重试」) */
  const [asking, setAsking] = useState<{ id: number; what: 'cancel' | 'take'; failed?: string } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [errs, setErrs] = useState<Record<number, string>>({});
  const head = useRef<HTMLDivElement>(null);

  const load = () =>
    fetchSubmissions().then((r) => {
      setList(r.submissions);
      setLimits(r.limits);
      setSubmitBan(readBan(r.ban));
    });
  // 取不到(断网、服务器出错)隔一会儿再问,窗口开着就一直试
  useEffect(() => {
    if (!on) return;
    let live = true;
    let got = false;
    let wait = 5000;
    let t: ReturnType<typeof setTimeout> | undefined;
    const tryLoad = () => {
      clearTimeout(t);
      void load().then(
        () => void (got = true),
        () => {
          if (!live || got) return;
          t = setTimeout(tryLoad, wait);
          wait = Math.min(wait * 2, 60_000);
        },
      );
    };
    tryLoad();
    const online = () => !got && tryLoad();
    window.addEventListener('online', online);
    return () => {
      live = false;
      clearTimeout(t);
      window.removeEventListener('online', online);
    };
  }, [on]);
  const shown = list ? shownSubmissions(list) : null;
  useEffect(() => {
    if (scrollTo && shown) head.current?.scrollIntoView({ block: 'start' });
  }, [scrollTo, !!shown]);
  if (!on || !shown) return null;

  const act = (s: Submission, what: 'cancel' | 'take') => {
    setBusy(s.id);
    setErrs(({ [s.id]: _drop, ...rest }) => rest);
    setAsking((a) => (a?.id === s.id ? { ...a, failed: undefined } : a));
    const done =
      what === 'cancel'
        ? cancelSubmission(s.id).then(() => setList((l) => (l ?? []).filter((x) => x.id !== s.id)))
        : takedownSubmission(s.id).then((got) => setList((l) => (l ?? []).map((x) => (x.id === s.id ? { ...x, ...got, updatedAt: got.updatedAt ?? new Date().toISOString() } : x))));
    void done
      .then(() => {
        void load().catch(() => {});
        setAsking(null);
      })
      .catch((e: unknown) => {
        const why = failText(e);
        setErrs((m) => ({ ...m, [s.id]: why }));
        // 没成:留在确认里,把原因写在行里、按钮换成「重试」
        setAsking((a) => (a?.id === s.id ? { ...a, failed: why } : a));
        // 状态在别处变了(审完了、已经撤下了):照服务器的重新列
        if (e instanceof ServerError && e.code === 'conflict') void load().catch(() => {});
      })
      .finally(() => setBusy(null));
  };
  const look = (workId: string) => {
    closeAccountPanel();
    openGalleryWork(workId);
  };

  return (
    <>
      <div className="acct-gh" ref={head} data-testid="my-submissions-head">
        我的投稿
        {limits && (
          <span className="sub-q">
            今天还能投 <b>{Math.max(0, limits.perDay - limits.usedToday)}</b> 次，等审 <b>{limits.pending}</b> / {limits.pendingMax}
          </span>
        )}
      </div>
      <div className="acct-grp" data-testid="my-submissions">
        {!shown.length && (
          <div className="acct-gr">
            <Icon name="image" size={19} />
            <span className="main">
              <b>还没投过</b>
              <small className="sub-wrap">在世界的「存档」里点「投到作品墙…」，我们看过就放上去</small>
            </span>
          </div>
        )}
        {shown.map((s) => {
          const w = rowWords(s, phone);
          const thumb = submitThumb(s);
          const askRow = asking?.id === s.id ? asking : null;
          const ask = askRow?.what ?? null;
          const err = errs[s.id];
          const off = busy === s.id;
          const confirm =
            ask === 'take'
              ? s.kind === 'plugin'
                ? `从作品墙撤下「${s.title}」？作品墙上马上就看不到了，已经装了的人照常能用；想再上墙要投新的一版、重新审。`
                : `从作品墙撤下「${s.title}」？作品墙上马上就看不到了。别人已经另存的在他们自己的浏览器里，删不掉；想再上墙要重新投、重新审。`
              : '撤回这件投稿？还没审完，撤回就不审了，今天用掉的次数不退。';
          return (
            <div className={`acct-gr${askRow ? ' sub-ask' : ''}`} key={s.id} data-sub={s.id} data-status={s.status}>
              <span className={`th2${s.kind === 'plugin' ? ' sub-pi' : ''}`} style={thumb ? { backgroundImage: `url(${JSON.stringify(thumb)})` } : undefined} />
              <span className="main">
                <b>{s.title}</b>
                {askRow ? (
                  <small className={askRow.failed ? 'sub-wrap sub-err' : undefined}>
                    {askRow.failed ? `没成：${askRow.failed}` : off ? '正在办…' : confirm}
                  </small>
                ) : err ? (
                  <small className="sub-wrap sub-err">{err}</small>
                ) : (
                  <small className="sub-wrap">
                    <span className={`sub-st ${w.st}`}>{w.label}</span>
                    {w.text}
                  </small>
                )}
              </span>
              {askRow ? (
                <span className="sub-acts">
                  <button className="mini" data-act="sub-keep" disabled={off} onClick={() => setAsking(null)}>
                    取消
                  </button>
                  <button className="mini red" data-act={ask === 'take' ? 'sub-take-yes' : 'sub-cancel-yes'} disabled={off} onClick={() => act(s, askRow.what)}>
                    {off ? '正在办…' : askRow.failed ? '重试' : ask === 'take' ? '撤下' : '撤回'}
                  </button>
                </span>
              ) : (
                w.acts.length > 0 && (
                  <span className="sub-acts">
                    {w.acts.map((a) =>
                      a === 'look' ? (
                        <button key={a} className="mini" data-act="sub-look" onClick={() => s.workId && look(s.workId)}>
                          看看
                        </button>
                      ) : (
                        <button key={a} className={`mini${a === 'take' ? ' red' : ''}`} data-act={a === 'take' ? 'sub-take' : 'sub-cancel'} disabled={off} onClick={() => setAsking({ id: s.id, what: a })}>
                          {a === 'take' ? '撤下' : '撤回'}
                        </button>
                      ),
                    )}
                  </span>
                )
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
