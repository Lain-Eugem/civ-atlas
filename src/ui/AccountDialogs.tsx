/**
 * 网站账号的几个窗口(电脑是居中的弹窗,手机是从下面升起的卡片):
 *
 *   登录       邮箱收验证码(不设密码);「手机号」那一格先置灰写"暂未开放"(网页这边还没做手机号登录);
 *              邀请制下新邮箱要邀请码:从邀请链接打开的已经填好,没填的点"获取验证码"时先说明、露出邀请码一栏(不发邮件)
 *   账号       最近删除、AI 积分(「使用 AI 功能」关着时不显示)、我的投稿(MySubmissions.tsx)、传到账号的世界、分享出去的世界(复制链接、停止分享);
 *              左下注销账号,右下退出登录
 *   退出登录   问这台设备上的世界留不留(默认留)
 *   注销账号   给自己的邮箱发验证码,填上才注销(账号里的都删掉;这台设备上的不动)
 *   分享       一个开关管开和停;署名(别人另存时写进底稿出处,默认不填);勾选「停在这一刻」(和存档菜单同一个,默认勾着:
 *              短链接后面带上 # 那段,对方打开停在这一年、选中的国家或州、同样的镜头;不经服务器,每次复制的链接各带各的);
 *              短链接、复制;手机上多一个"发给…"(系统分享)
 *
 *   openLogin() / openAccount() / openShareDialog(id, 名字)   打开它们(「我的世界」右上、AI 设置、存档菜单)
 *   openSubmitDialog(作品)   投到作品墙(存档菜单、预设菜单、调规则那一页的「···」;窗口在 SubmitDialog.tsx,点开才下载)
 *   openPhoneDialog(从哪来)   绑手机号、换手机号(窗口在 PhoneDialog.tsx,点开才下载)
 *   openTrash()   「我的世界」那一页换成最近删除(App 回到我的世界)
 *   AccountHost   窗口本身,App 里一直挂着
 *
 * 这里只留登录窗和外壳;登录以后才用得到的窗口在 AccountPanels.tsx,点开才下载。
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons';
import { PRIVACY_URL, TERMS_URL } from './links';
import { closeAiSettings } from './AiSettings';
import { refreshOfficialAccount } from '../ai/providers/official';
import { ServerError } from '../account/server';
import { fetchAuthOptions, getSession, login, onAccountDisabled, pendingInvite, sendCode, useSession, type AuthOptions } from '../account/session';
import { showToast } from './toastStore';
import { workKey, type SubmitWork } from './submitView';
import './account.css';

// ---------------------------------------------------------------------------
// 开关

export type Panel =
  | { kind: 'login' }
  /** to:打开时滚到哪一组 */
  | { kind: 'account'; to?: 'submissions' }
  | { kind: 'logout' }
  | { kind: 'delete' }
  | { kind: 'share'; worldId: string; title: string }
  /** 地图带不进配方的世界还没传到账号:先问一句,传好接着开分享窗 */
  | { kind: 'share-ask'; worldId: string; title: string }
  | { kind: 'submit'; work: SubmitWork; view?: SubmitView }
  /** back:绑好、取消以后回到哪个窗;then:绑好以后接着做的 */
  | { kind: 'phone'; mode: PhoneMode; back: Panel | null; then?: () => void };

// 已经登着的账号被停用(服务器的 401 带 ban):session.ts 已经退出登录,这里说一声;普通的登录过期不说
onAccountDisabled(() => showToast({ id: 'account-disabled', kind: 'warn', text: '这个账号已停用，已经退出登录', more: ['世界还在这个浏览器里'] }));

let panel: Panel | null = null;
let trash = false;
/** 账号窗、分享窗、最近删除是替哪一次登录(令牌)开的:别的标签页退出、换了账号,开着的就是原来那个账号的了,关掉 */
let openedFor: string | null = null;
const forNow = () => {
  openedFor = getSession()?.token ?? null;
};
let version = 0;
const subs = new Set<() => void>();
function emit() {
  version++;
  for (const f of subs) f();
}
function useUi() {
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => version,
    () => version,
  );
  return { panel, trash };
}

export function openLogin(): void {
  panel = { kind: 'login' };
  emit();
}
/** 也会被直接当成点击的处理函数,传进来的不是 'submissions' 就当没给 */
export function openAccount(to?: 'submissions'): void {
  panel = { kind: 'account', ...(to === 'submissions' ? { to } : {}) };
  forNow();
  emit();
}
export function openShareDialog(worldId: string, title: string): void {
  panel = { kind: 'share', worldId, title };
  forNow();
  emit();
}
export function openShareAsk(worldId: string, title: string): void {
  panel = { kind: 'share-ask', worldId, title };
  forNow();
  emit();
}
/** 账号停了投稿时先说原因:ban 从「投到作品墙…」来,ban-share 从「分享…」来(其实没停就接着开分享窗) */
export type SubmitView = 'ban' | 'ban-share';
export function openSubmitDialog(work: SubmitWork, view?: SubmitView): void {
  panel = { kind: 'submit', work, ...(view ? { view } : {}) };
  forNow();
  emit();
}
/** 绑手机号的窗从哪来:投稿、分享(绑好接着做),账号窗里的「没绑定」「换一个」(绑好、取消都回账号窗) */
export type PhoneMode = 'submit' | 'share' | 'account' | 'change';
export function openPhoneDialog(mode: PhoneMode, then?: () => void): void {
  const fromAccount = mode === 'account' || mode === 'change';
  const back = fromAccount ? { kind: 'account' as const } : panel?.kind === 'submit' || panel?.kind === 'share' ? panel : null;
  panel = { kind: 'phone', mode, back, ...(then ? { then } : {}) };
  forNow();
  emit();
}

/** 账号窗里换到退出登录、注销账号 */
export function goToPanel(kind: 'logout' | 'delete'): void {
  panel = { kind };
  emit();
}
export function closeAccountPanel(): void {
  if (!panel) return;
  panel = null;
  emit();
}

/** React:开着的是登录窗 / 账号窗(「我的世界」右上那个按钮显示按下) */
export function useAccountPanelOpen(): boolean {
  const k = useUi().panel?.kind;
  return k === 'login' || k === 'account';
}

/** 回到"我的世界"(App 登记) */
let goHome: (() => void) | null = null;
export function setGoHome(f: (() => void) | null): void {
  goHome = f;
}
/** 「我的世界」那一页换成最近删除 */
export function openTrash(): void {
  panel = null;
  trash = true;
  forNow();
  emit();
  closeAiSettings();
  goHome?.();
}
export function closeTrash(): void {
  if (!trash) return;
  trash = false;
  emit();
}
/** React:「我的世界」那一页是不是在看最近删除(只算替现在登着的这次登录开的) */
export function useTrashView(): boolean {
  const { trash: t } = useUi();
  const s = useSession();
  return t && !!s && s.token === openedFor;
}

/** 窗口:App 里挂一次 */
export function AccountHost({ phone }: { phone: boolean }) {
  const { panel: p, trash: t } = useUi();
  const s = useSession();
  // 退出了、换了账号(别的标签页里、令牌过期):开着的账号窗、分享窗、最近删除都是原来那个账号的,关掉;只留登录窗
  const stale = !s || s.token !== openedFor;
  useEffect(() => {
    if (p && p.kind !== 'login' && stale) closeAccountPanel();
    if (p?.kind === 'login' && s) closeAccountPanel();
    if (t && stale) closeTrash();
  }, [p, s, t, stale]);
  if (!p) return null;
  const close = closeAccountPanel;
  const back = () => {
    panel = { kind: 'account' };
    emit();
  };
  if (p.kind === 'login') return <LoginDialog phone={phone} onClose={close} />;
  if (stale) return null;
  if (p.kind === 'submit')
    return (
      <Suspense fallback={null}>
        <SubmitPanel key={workKey(p.work)} phone={phone} work={p.work} view={p.view} onClose={close} />
      </Suspense>
    );
  if (p.kind === 'phone') {
    const leave = (done: boolean) => {
      panel = done || p.mode === 'account' || p.mode === 'change' ? p.back : null;
      emit();
      if (done) p.then?.();
    };
    return (
      <Suspense fallback={null}>
        <PhonePanel phone={phone} mode={p.mode} onDone={() => leave(true)} onClose={() => leave(false)} />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <Panels panel={p} phone={phone} onClose={close} onBack={back} />
    </Suspense>
  );
}

/** 窗口的代码下载不下来:说一句,带「重新加载」 */
export function PanelsMissing() {
  useEffect(() => {
    closeAccountPanel();
    showToast({ id: 'account-load', kind: 'error', text: '没能打开这个窗口', more: ['网络断了，或者网站刚更新过，重新加载试试'], action: { label: '重新加载', act: 'account-reload', onClick: () => location.reload() } });
  }, []);
  return null;
}

const Panels = lazy(() => import('./AccountPanels').catch(() => ({ default: PanelsMissing as unknown as typeof import('./AccountPanels').default })));
const SubmitPanel = lazy(() => import('./SubmitDialog').catch(() => ({ default: PanelsMissing as unknown as typeof import('./SubmitDialog').default })));
const PhonePanel = lazy(() => import('./PhoneDialog').catch(() => ({ default: PanelsMissing as unknown as typeof import('./PhoneDialog').default })));

// ---------------------------------------------------------------------------
// 窗口外壳

/**
 * 窗口栈:后来开的盖在先开的上面。Esc 只关最上面那一层,Tab / Shift+Tab 把焦点圈在窗口里,
 * 开着时不会跑到后面的页面上;关掉以后把焦点还给点开它的地方。
 */
interface DialogEntry {
  node: HTMLElement;
  esc: () => void;
}
const dialogStack: DialogEntry[] = [];

/** 窗口里能聚焦、看得见的东西 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function focusables(node: HTMLElement): HTMLElement[] {
  return [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

/** 把一层窗口登记进栈:进栈 / 出栈、Esc、Tab 圈焦点、打开时聚焦、关闭后归还焦点 */
function useDialogLayer(nodeRef: RefObject<HTMLDivElement>, onClose: (() => void) | undefined) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    const entry: DialogEntry = { node, esc: () => close.current?.() };
    dialogStack.push(entry);
    const before = document.activeElement as HTMLElement | null;
    // 打开时焦点放进窗口(子组件已经自己聚焦了就不动,比如登录窗的邮箱框)
    if (!node.contains(document.activeElement)) (focusables(node)[0] ?? node).focus();
    const onKey = (e: KeyboardEvent) => {
      // 只由最上面那层处理:下面那层(先开的)别跟着关掉、也别抢 Tab
      if (dialogStack[dialogStack.length - 1] !== entry) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        entry.esc();
      } else if (e.key === 'Tab') {
        const list = focusables(entry.node);
        if (!list.length) {
          e.preventDefault();
          return;
        }
        const cur = document.activeElement as HTMLElement | null;
        const at = cur ? list.indexOf(cur) : -1;
        // 焦点在窗口外,或到了头 / 尾:绕到另一头
        const next = at < 0 ? (e.shiftKey ? list.length - 1 : 0) : e.shiftKey && at === 0 ? list.length - 1 : !e.shiftKey && at === list.length - 1 ? 0 : at;
        if (next !== at) {
          e.preventDefault();
          list[next].focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      const i = dialogStack.indexOf(entry);
      if (i >= 0) dialogStack.splice(i, 1);
      window.removeEventListener('keydown', onKey, true);
      // 关掉以后把焦点还回去(那个元素还在页面上、也没有别的窗口开着)
      if (before?.isConnected && !dialogStack.length) before.focus();
    };
  }, [nodeRef]);
}

export function Dialog({
  phone,
  label,
  width = 420,
  onClose,
  head,
  children,
  testId,
  className,
  inPlace,
}: {
  phone: boolean;
  label: string;
  width?: number;
  onClose?: () => void;
  /** 标题那一行(不给 = 标题 + 右上关闭) */
  head?: ReactNode;
  children: ReactNode;
  testId?: string;
  /** 窗口上多加的 class */
  className?: string;
  /** 就地放,窗口才盖不住顶上的提示条 */
  inPlace?: boolean;
}) {
  const dlgRef = useRef<HTMLDivElement>(null);
  useDialogLayer(dlgRef, onClose);
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const body = (
    <div
      className={`acct-bg${phone ? ' sheet' : ''}`}
      onPointerDown={(e) => {
        stop(e);
        if (e.target === e.currentTarget) onClose?.();
      }}
      onClick={stop}
      onWheel={stop}
    >
      <div ref={dlgRef} tabIndex={-1} className={`acct-dlg${phone ? ' sheet' : ''}${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={label} data-testid={testId} style={phone ? undefined : { width }}>
        {phone && <div className="acct-grip" aria-hidden="true" />}
        {head ?? (
          <div className="acct-head">
            <h2>{label}</h2>
            {onClose && <CloseX onClose={onClose} />}
          </div>
        )}
        {children}
      </div>
    </div>
  );
  return inPlace ? body : createPortal(body, document.body);
}

export function CloseX({ onClose }: { onClose: () => void }) {
  return (
    <button className="acct-x" onClick={onClose} title="关闭" aria-label="关闭">
      <Icon name="close" size={14} />
    </button>
  );
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const codeOf = (e: unknown) => (e instanceof ServerError ? e.code : '');

/** 重发倒计时:每秒刷新一次 */
export function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= until) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const sendLabel = (sent: boolean, left: number, busy: boolean) => (busy ? '正在发送' : !sent ? '获取验证码' : left > 0 ? `重发（${left} 秒）` : '重发验证码');

// ---------------------------------------------------------------------------
// 登录

interface Sent {
  to: string;
  until: number;
  /** 验证码几秒内有效 */
  ttl: number;
  dev?: string;
}

type Shut = { head: string; sub: string };

/** 登录被拒是因为账号停用了(401 带 ban):红底那块的两句。注销前停用的邮箱再注册,照服务器的话 */
function shutOf(e: unknown): Shut | null {
  if (!(e instanceof ServerError) || e.code !== 'auth' || !e.data.ban || typeof e.data.ban !== 'object') return null;
  const ban = e.data.ban as { reasonText?: unknown; carried?: unknown };
  if (ban.carried === true) {
    const [head, ...rest] = e.message.split('。');
    return { head, sub: rest.join('。') };
  }
  const why = typeof ban.reasonText === 'string' ? ban.reasonText.replace(/[。.]$/, '') : '';
  return { head: '这个账号已停用，登录不了', sub: `${why ? `原因：${why}。` : ''}账号里的世界还在服务器上留着。觉得弄错了，请到 QQ 交流群联系我们。` };
}

function LoginDialog({ phone, onClose }: { phone: boolean; onClose: () => void }) {
  const [opts, setOpts] = useState<AuthOptions | null>(null);
  useEffect(() => {
    let live = true;
    void fetchAuthOptions().then((o) => live && setOpts(o));
    return () => {
      live = false;
    };
  }, []);
  const linkInvite = useMemo(() => pendingInvite(), []);
  const [email, setEmail] = useState('');
  const [invite, setInvite] = useState(linkInvite ?? '');
  const [showInvite, setShowInvite] = useState(!!linkInvite);
  const [needInvite, setNeedInvite] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const [code, setCode] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState<'send' | 'login' | null>(null);
  const [err, setErr] = useState<{ at: 'email' | 'invite' | 'code'; text: string } | null>(null);
  /** 账号停用了:登录被拒时服务器说的 */
  const [shut, setShut] = useState<Shut | null>(null);
  const left = useCountdown(sent?.until ?? null);
  const emailRef = useRef<HTMLInputElement>(null);
  const inviteRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => emailRef.current?.focus(), []);

  const inviteOnly = opts?.inviteOnly ?? !!linkInvite;
  const okEmail = EMAIL.test(email.trim());
  const sentNow = !!sent && sent.to === email.trim();
  const canSend = okEmail && !busy && !(sentNow && left > 0);
  const canLogin = sentNow && /^\d{6}$/.test(code.trim()) && agree && !busy;

  const send = async () => {
    if (!canSend) return;
    setBusy('send');
    setErr(null);
    try {
      const r = await sendCode(email, showInvite ? invite : undefined);
      setSent({ to: email.trim(), until: Date.now() + r.resendAfter * 1000, ttl: r.expiresIn ?? opts?.codeTtlSec ?? 600, dev: r.devCode });
      setNeedInvite(false);
      if (r.devCode) setCode(r.devCode);
      setTimeout(() => codeRef.current?.focus(), 0);
    } catch (e) {
      const c = codeOf(e);
      if (c === 'need-invite') {
        setNeedInvite(true);
        setShowInvite(true);
        setTimeout(() => inviteRef.current?.focus(), 0);
      } else if (c === 'bad-invite') {
        setShowInvite(true);
        setErr({ at: 'invite', text: errText(e) });
      } else setErr({ at: 'email', text: errText(e) });
    } finally {
      setBusy(null);
    }
  };
  const submit = async () => {
    if (!canLogin) return;
    setBusy('login');
    setErr(null);
    try {
      await login(email, code, showInvite ? invite : undefined);
      void refreshOfficialAccount();
      onClose();
    } catch (e) {
      const c = codeOf(e);
      const off = shutOf(e);
      if (off) {
        setShut(off);
        setSent(null);
        setCode('');
      } else if (c === 'need-invite' || c === 'bad-invite') {
        setShowInvite(true);
        setErr({ at: 'invite', text: errText(e) });
      } else setErr({ at: 'code', text: errText(e) });
      setBusy(null);
    }
  };
  const fromLink = !!linkInvite && invite === linkInvite && err?.at !== 'invite';
  const mins = Math.max(1, Math.round((sent?.ttl ?? 600) / 60));

  return (
    <Dialog phone={phone} label="登录" onClose={busy ? undefined : onClose} testId="login-dialog">
      <div className="acct-body">
        <div className="acct-seg" role="tablist" aria-label="登录方式">
          <button className="on" role="tab" aria-selected="true">
            邮箱
          </button>
          {/* 手机号登录网页这边还没做:服务器开了也先置灰 */}
          <button role="tab" aria-selected="false" disabled title="手机号登录暂未开放">
            手机号<em>暂未开放</em>
          </button>
        </div>
        <p className="acct-lead">
          {inviteOnly ? '用邮箱收验证码登录，不用设密码。现在是邀请制，新邮箱第一次登录要填邀请码。' : '用邮箱收验证码登录，不用设密码。第一次登录会自动注册。'}
        </p>
        <div>
          <div className="acct-fld">
            <input
              ref={emailRef}
              className="acct-in"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="邮箱"
              aria-label="邮箱"
              data-testid="login-email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (err?.at === 'email') setErr(null);
                if (needInvite) setNeedInvite(false);
                if (shut) setShut(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && void send()}
            />
            <button className="acct-btn lg" data-act="send-code" disabled={!canSend} onClick={() => void send()} style={phone ? { padding: '0 10px' } : undefined}>
              {sendLabel(sentNow, left, busy === 'send')}
            </button>
          </div>
          {err?.at === 'email' && <p className="acct-err">{err.text}</p>}
        </div>
        {shut && (
          <div className="acct-callout bad" data-testid="login-shut">
            <Icon name="ban" size={16} />
            <span>
              <b>{shut.head}</b>
              {shut.sub && (
                <>
                  <br />
                  <span className="sub">{shut.sub}</span>
                </>
              )}
            </span>
          </div>
        )}
        {needInvite && (
          <div className="acct-callout" data-testid="need-invite">
            <Icon name="info" size={16} />
            <span>
              这个邮箱还没有账号。现在只开放给收到邀请的人，填上邀请码就能注册。
              <br />
              <span className="sub">没有邀请码也没关系：不登录照样什么都能用，世界存在这个浏览器里。</span>
            </span>
          </div>
        )}
        {showInvite && (
          <div>
            <label className="acct-in inv">
              <span className="pre">邀请码</span>
              <input
                ref={inviteRef}
                autoComplete="off"
                spellCheck={false}
                data-testid="login-invite"
                value={invite}
                onChange={(e) => {
                  setInvite(e.target.value);
                  if (err?.at === 'invite') setErr(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && void send()}
              />
            </label>
            {fromLink && (
              <p className="acct-okl">
                <Icon name="check" size={14} />
                从邀请链接带过来的，已经填好
              </p>
            )}
            {err?.at === 'invite' && <p className="acct-err">{err.text}</p>}
          </div>
        )}
        <div>
          <input
            ref={codeRef}
            className="acct-in code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="6 位验证码"
            aria-label="验证码"
            data-testid="login-code"
            disabled={!sentNow}
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
              if (err?.at === 'code') setErr(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
          {sentNow && (
            <p className="acct-small" style={{ marginTop: 6 }}>
              验证码已发到 {sent!.to}，{mins} 分钟内有效。没收到的话，看看垃圾邮件。
              {sent!.dev && `（开发用假服务器：验证码是 ${sent!.dev}，已经填好）`}
            </p>
          )}
          {err?.at === 'code' && <p className="acct-err">{err.text}</p>}
        </div>
        <label className="acct-chk">
          <input type="checkbox" data-testid="login-agree" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <i className="b" aria-hidden="true">
            {agree && <Icon name="check" size={12} />}
          </i>
          <span>
            已阅读并同意{' '}
            <a href={TERMS_URL} target="_blank" rel="noreferrer">
              用户协议
            </a>{' '}
            和{' '}
            <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
              隐私政策
            </a>
          </span>
        </label>
        {phone && <LoginFoot busy={busy === 'login'} disabled={!canLogin} onLogin={submit} phone />}
      </div>
      {!phone && <LoginFoot busy={busy === 'login'} disabled={!canLogin} onLogin={submit} />}
    </Dialog>
  );
}

function LoginFoot({ busy, disabled, onLogin, phone }: { busy: boolean; disabled: boolean; onLogin: () => void; phone?: boolean }) {
  const line = '登录不会上传世界，世界还存在这个浏览器里。';
  const btn = (
    <button className="acct-btn blue full" data-act="login" disabled={disabled} onClick={onLogin}>
      {busy ? '正在登录' : '登录'}
    </button>
  );
  if (phone)
    return (
      <>
        <div style={{ marginTop: 2 }}>{btn}</div>
        <p className="acct-small center" style={{ marginTop: -4 }}>
          {line}
        </p>
      </>
    );
  return (
    <div className="acct-foot col">
      {btn}
      <p className="acct-small center">{line}</p>
    </div>
  );
}
