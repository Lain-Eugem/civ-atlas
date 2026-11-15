/**
 * 读史书(右上"已完成 · 打开"、已写的史书列表打开):小字元信息、宋体大标题、目录、分章正文。
 * 写的时候也能打开:边写边显示,可以停止。工具:复制、导出 Markdown、重写、删除。
 * 重写过的书有好几版:书名右边「‹ 2 / 3 ›」左右翻,点中间列出每一版;看的是哪版,复制、导出、故事长图就用哪版。
 * 「删除」只删正在看的这一版(只剩一版时删整部)。浏览器存储满了、新写的那版没存上:正文上面一条红字,带「删掉第 1 版再存」。
 * 像一本书,纸色底 —— 不跟着图层换深色。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Civ } from '../gen/civ/types';
import { getNote, useNotesVersion } from '../ai/library';
import { HISTORY_LENGTHS, textLength, type HistoryLength, type HistoryStyle } from '../ai/prompts/history';
import {
  BOOK_VERSIONS_MAX,
  asHistoryNote,
  bookHowText,
  bookRedoScope,
  bookVersions,
  deleteBookVersion,
  dropOldestVersion,
  historyFileName,
  historyMarkdown,
  historyNoteStatus,
  historyStyleLabel,
  historyWriter,
  pickBookVersion,
  shortDate,
  unsavedVersions,
  versionsStale,
  type HistoryNote,
} from '../ai/history';
import { isLifeScope, lifeKind } from '../ai/prompts/lives';
import { currentWorld, useSavesVersion } from './saveStore';
import { bookTitleText, bookUnit, closeBookReader, getBookSource, openBookReader, startBook, stopBook, useBook } from './bookStore';
import { useDialogEscape } from './BookDialog';
import { useEra } from './editsStore';
import { copyText } from './clipboard';
import { eraText, yearFull, yearSpan, yearSpanAt, type Era } from '../gen/era';
import { AiTag } from './aiTag';
import './book.css';

const fmt = (n: number) => n.toLocaleString('en-US');

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------------------
// 正文排版:AI 写的 Markdown(只认标题、引用、列表、分隔线、粗体;其余当段落)

interface Chapter {
  id: string;
  /** "卷一" / "第一章" / "本纪" */
  n: string;
  /** 章名 */
  t: string;
  /** "1045–1536" */
  y: string;
  /** 列传这一篇写了谁(从"### 某某传"取):目录里写"列传 | 司空弈、顾珏" */
  who?: string[];
}

/** "## 卷一 诸部初立(第 0—1045 年)" / "## 本纪·大澜王朝" / "## 列传" → 卷次、章名、年份(设了纪年按纪年短写:"前 2500–前 1455") */
export function parseChapter(line: string, era?: Era | null): Omit<Chapter, 'id'> {
  let rest = line.trim();
  let y = '';
  const ym = /\s*[(（]\s*(?:第\s*)?(\d+)\s*(?:年)?\s*[—–\-~至到]+\s*(?:第\s*)?(\d+)\s*年?\s*[)）]\s*$/.exec(rest);
  if (ym) {
    y = era ? yearSpan(Number(ym[1]), Number(ym[2]), era) : `${ym[1]}–${ym[2]}`;
    rest = rest.slice(0, ym.index).trim();
  }
  const cm = /^(第[一二三四五六七八九十百零〇两\d]+[章卷篇回]|卷[一二三四五六七八九十百零〇\d]+)\s*[·・:：、.\s]?\s*(.*)$/.exec(rest);
  if (cm && cm[2]) return { n: cm[1], t: eraText(cm[2].trim(), era), y };
  const pm = /^(本纪|世家|列传)\s*[·・:：]\s*(.+)$/.exec(rest);
  if (pm) return { n: pm[1], t: eraText(pm[2].trim(), era), y };
  return { n: '', t: eraText(rest, era), y };
}

/** "司空弈传" / "一、顾珏传" / "司空弈、顾珏合传(第 1200—1260 年)" → 传主的名字;不像传名的 → 空 */
export function lifeName(line: string): string {
  const t = line
    .trim()
    .replace(/\s*[(（][^()（）]*[)）]\s*$/, '')
    .replace(/^[一二三四五六七八九十百\d]+\s*[、.．]\s*/, '');
  if (t.startsWith('列传')) return '';
  const m = /^(.+?)\s*合?传$/.exec(t);
  return m && m[1].length <= 16 ? m[1].trim() : '';
}

function inline(s: string): ReactNode {
  const parts = s.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => (p.startsWith('**') && p.endsWith('**') && p.length > 4 ? <b key={i}>{p.slice(2, -2)}</b> : p));
}

/** 排版;正文里的"第 N 年"按纪年写(era) */
export function layout(text: string, bookTitle: string, era?: Era | null): { blocks: ReactNode[]; chapters: Chapter[] } {
  const blocks: ReactNode[] = [];
  const chapters: Chapter[] = [];
  const lives = (c: Chapter | undefined) => !!c && (c.n === '列传' || (!c.n && c.t === '列传'));
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const h = /^(#{1,6})\s*(.*)$/.exec(line);
    if (h) {
      const body = h[2].replace(/\*\*/g, '').trim();
      // 模型偶尔先写一行"# 书名":和大标题重复,不要
      const norm = (x: string) => x.replace(/[《》\s]/g, '');
      if (h[1].length === 1 && (!blocks.length || norm(body) === norm(bookTitle))) return;
      if (h[1].length <= 2) {
        const c = { id: `bk-ch-${chapters.length}`, ...parseChapter(body, era) };
        chapters.push(c);
        blocks.push(
          <h3 key={i} id={c.id} className="bk-ch">
            {c.n && <span className="bk-ch-n">{c.n}</span>}
            <span className="bk-ch-t">{c.t}</span>
            {c.y && <span className="bk-ch-y">{c.y}</span>}
          </h3>,
        );
      } else {
        const c = chapters[chapters.length - 1];
        const who = lives(c) ? lifeName(body) : '';
        if (who && !c.who?.includes(who)) c.who = [...(c.who ?? []), who];
        blocks.push(<h4 key={i}>{inline(eraText(body, era))}</h4>);
      }
      return;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) return void blocks.push(<hr key={i} />);
    const q = /^>\s?(.*)$/.exec(line);
    if (q) return void blocks.push(<p key={i} className="bk-quote">{inline(eraText(q[1], era))}</p>);
    const li = /^[-*·]\s+(.*)$/.exec(line);
    if (li) return void blocks.push(<p key={i} className="bk-li">{inline(eraText(li[1], era))}</p>);
    blocks.push(<p key={i}>{inline(eraText(line, era))}</p>);
  });
  return { blocks, chapters };
}

// ---------------------------------------------------------------------------

/** 翻版本的箭头 */
function Chevron({ dir }: { dir: -1 | 1 }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d={dir < 0 ? 'M8.6 2.8 4.4 7l4.2 4.2' : 'M5.4 2.8 9.6 7l-4.2 4.2'} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * 元信息:"纪传体，中篇，截至 3000 年"(一国的写起止年份;设了纪年:"截至公元 501 年""公元前 820–前 11 年");
 * 列传、家传:"列传，史书体，约 2000 字"
 */
function metaLine(style: HistoryStyle, length: HistoryLength, range: string, scopeKind: string, era: Era | undefined): string {
  if (isLifeScope({ kind: scopeKind })) return bookHowText({ kind: scopeKind }, style, length);
  const m = /(\d+)\D+(\d+)/.exec(range);
  const when = !m ? eraText(range, era) : era ? (scopeKind === 'world' ? `截至${yearFull(Number(m[2]), era)}` : yearSpanAt(Number(m[1]), Number(m[2]), era)) : scopeKind === 'world' ? `截至 ${m[2]} 年` : `${m[1]}–${m[2]} 年`;
  return [historyStyleLabel(style), `${HISTORY_LENGTHS[length].label}篇`, when].filter(Boolean).join('，');
}

export function BookReader({ civ }: { civ: Civ }) {
  const st = useBook();
  useDialogEscape(st.reader.open, closeBookReader);
  if (!st.reader.open) return null;
  return <Reader key={`${st.reader.stamp}`} civ={civ} />;
}

function Reader({ civ }: { civ: Civ }) {
  const st = useBook();
  useSavesVersion();
  const notesVersion = useNotesVersion();
  const world = currentWorld();
  const era = useEra();
  const job = st.job;
  const key = st.reader.key;
  const note: HistoryNote | null = key && world ? asHistoryNote(getNote(world.id, key)) : null;
  const live = !note && key === null && job ? job : null;
  const status = useMemo(() => (note ? historyNoteStatus(civ, note, getBookSource()) : null), [note, civ]);
  const [copied, setCopied] = useState(false);
  const [armDel, setArmDel] = useState(false);

  // 这一部存着的几版;正在写的是写过的书的新一版时,存着的几版也在(能翻回去看),正在写的排在最后
  const book = note ?? (live && world && live.world === world.id ? asHistoryNote(getNote(world.id, live.key)) : null);
  const vs = useMemo(() => (book ? bookVersions(book) : null), [book]);
  const staleVers = useMemo(() => (book ? versionsStale(civ, book, getBookSource()) : []), [book, civ]);
  const unsaved = useMemo(() => (note && world ? unsavedVersions(world.id, note) : []), [note, world?.id, notesVersion]);
  const withLive = !!vs && !!job && job.world === world?.id && job.key === book?.key && job.status !== 'done' && (!!live || job.status === 'writing');
  const count = vs ? vs.list.length + (withLive ? 1 : 0) : 1;
  const pos = live ? count - 1 : (vs?.at ?? 0);
  const [verList, setVerList] = useState(false);
  const verRef = useRef<HTMLDivElement>(null);
  // 翻到第 i 版(下标):正在写的那版 = 接着看正在写的;存着的 = 记下停在这版(下次打开、故事长图用它),从头看
  const goTo = (i: number) => {
    setVerList(false);
    if (!world || !book || i < 0 || i >= count || i === pos) return;
    if (withLive && i === count - 1) return openBookReader(null);
    pickBookVersion(world.id, book.key, i);
    openBookReader(book.key);
  };
  // 版本列表开着:点别处、按 Esc 收起(Esc 不关阅读页)
  useEffect(() => {
    if (!verList) return;
    const down = (e: PointerEvent) => {
      if (!verRef.current?.contains(e.target as Node)) setVerList(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setVerList(false);
    };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [verList]);

  // 看着的那部被删了 / 找不到了:关上
  useEffect(() => {
    if (!note && !live) closeBookReader();
  }, [note, live]);

  const text = note ? note.text : (live?.text ?? '');
  const title = note ? note.book.title : (live?.title ?? '');
  const scope = note ? note.book.scope : (live?.opts.scope ?? { kind: 'world' });
  const name = bookTitleText(title, scope, world?.title, era);
  const { blocks, chapters } = useMemo(() => layout(text, name, era), [text, name, era]);
  const writing = !!live && live.status === 'writing';

  // 写的时候跟着往下滚(读者往上翻了就不跟)
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && writing && follow.current) el.scrollTop = el.scrollHeight;
  }, [text, writing]);

  if (!note && !live) return null;
  const style = note ? note.book.style : live!.opts.style;
  const length = note ? note.book.length : live!.opts.length;
  const range = note ? note.book.range : live!.range;
  const busy = job?.status === 'writing';
  // 重写按正在看的这版记的"写什么";它在现在的历史里找不到了(比如改过人物生年以后的旧版),用别的版里还找得到的
  const redoScope = note ? (status?.scope ?? bookRedoScope(civ, note, getBookSource())) : null;
  const redo = note ? (redoScope ? { scope: redoScope, style, length } : null) : live && !writing ? live.opts : null;
  // 重写 / 重试:阅读页接着看正在写的这一部
  const rewrite = () => {
    if (redo && startBook(redo)) openBookReader(null);
  };

  const info = note
    ? [`${fmt(textLength(note.text))} 字`, historyWriter(note, '，'), shortDate(note.createdAt)].filter(Boolean).join('，')
    : writing
      ? `正在写${live!.calls > 1 ? `第 ${live!.call + 1} ${bookUnit(style)}(共 ${live!.calls} ${bookUnit(style)})` : ''}…… ${text ? `${fmt(textLength(text))} 字` : ''}`
      : live!.status === 'stopped'
        ? '已停止,写到一半的没有保存。'
        : (live!.error?.message ?? '没写完');
  // 好几版时说"这一版";只有一版照旧说"这部史书""这篇列传"
  const many = count > 1;
  const nStored = vs?.list.length ?? 0;
  const life = isLifeScope(scope);

  const stopBubble = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <div className="bk-bg" onPointerDown={(e) => e.target === e.currentTarget && closeBookReader()}>
      <article className="bk-reader" data-theme="light" role="dialog" aria-modal="true" aria-label={name} onPointerDown={stopBubble} onWheel={stopBubble}>
        <header className="bk-r-head">
          <div className="bk-r-top">
            <span className="bk-meta">
              <AiTag />
              {metaLine(style, length, range, scope.kind, era)}
            </span>
            <button className="bk-x" onClick={closeBookReader} title="关闭" aria-label="关闭">
              ✕
            </button>
          </div>
          {many ? (
            <div className="bk-r-title">
              <h1 className="bk-book">{name}</h1>
              <div className="bk-ver" ref={verRef}>
                <div className="bk-ver-g">
                  <button className="bk-ver-a" data-act="book-ver-prev" disabled={pos <= 0} onClick={() => goTo(pos - 1)} title="上一版" aria-label="上一版">
                    <Chevron dir={-1} />
                  </button>
                  <button
                    className={`bk-ver-n${verList ? ' on' : ''}`}
                    data-act="book-ver-list"
                    aria-haspopup="menu"
                    aria-expanded={verList}
                    title="看全部几版"
                    onClick={() => setVerList(!verList)}
                  >
                    {pos + 1} / {count}
                  </button>
                  <button className="bk-ver-a" data-act="book-ver-next" disabled={pos >= count - 1} onClick={() => goTo(pos + 1)} title="下一版" aria-label="下一版">
                    <Chevron dir={1} />
                  </button>
                </div>
                {verList && vs && (
                  <div className="bk-ver-pop" role="menu" aria-label="几版">
                    {Array.from({ length: count }, (_, i) => count - 1 - i).map((i) => {
                      const v = vs.list[i];
                      const on = i === pos;
                      // 正在写的那版(排在最后):还没写完,只有字数
                      const when = v ? shortDate(v.createdAt) : job?.status === 'writing' ? '正在写' : job?.status === 'stopped' ? '已停止' : '没写完';
                      const sub = v ? [`${fmt(textLength(v.text))} 字`, historyWriter(v, '，')].filter(Boolean).join('，') : `${fmt(textLength(job?.text ?? ''))} 字`;
                      return (
                        <button key={i} className={`bk-ver-row${on ? ' on' : ''}`} role="menuitemradio" aria-checked={on} onClick={() => goTo(i)}>
                          <span className="bk-ver-ck">{on ? '✓' : ''}</span>
                          <span className="bk-ver-t">
                            第 {i + 1} 版{v && staleVers[i] && <em className="bk-tag">历史已变</em>}
                          </span>
                          <span className="bk-ver-d">{when}</span>
                          <span className="bk-ver-s">{sub}</span>
                        </button>
                      );
                    })}
                    <div className="bk-ver-foot">
                      {nStored >= BOOK_VERSIONS_MAX
                        ? `最多留 ${BOOK_VERSIONS_MAX} 版，${withLive ? '写完' : '再写一版'}会去掉最早的第 1 版。`
                        : `最多留 ${BOOK_VERSIONS_MAX} 版，再写一版旧的照样留着。`}
                      <br />
                      {scope.kind === 'world' || scope.kind === 'polity' ? '复制、导出、故事长图都用正在看的这一版。' : '复制、导出都用正在看的这一版。'}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <h1 className="bk-book">{name}</h1>
          )}
          <div className="bk-tools">
            <span className={`bk-info${live && !writing ? ' err' : ''}`} data-testid="book-info">
              {writing && <i className="bk-spin" />}
              {info}
            </span>
            {writing ? (
              <button className="bk-tool" data-act="book-stop" onClick={stopBook}>
                停止
              </button>
            ) : (
              <>
                {note && (
                  <>
                    <button
                      className="bk-tool"
                      onClick={async () => {
                        await copyText(`${name}\n\n${eraText(note.text.trim(), era)}\n`);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1600);
                      }}
                    >
                      {copied ? '已复制' : '复制'}
                    </button>
                    <button className="bk-tool" onClick={() => download(eraText(historyMarkdown(note, name.slice(1, -1)), era), historyFileName(note, name.slice(1, -1)))}>
                      导出
                    </button>
                  </>
                )}
                <button
                  className="bk-tool"
                  data-act="book-redo"
                  disabled={!redo || busy}
                  onClick={rewrite}
                  title={busy ? '正在写别的,写完才能重写' : redo ? '按现在的历史再写一版，旧的留着' : status?.why}
                >
                  {live ? '重试' : '重写'}
                </button>
                {note && (
                  <button
                    className={`bk-tool${armDel ? ' danger' : ''}`}
                    data-act="book-delete"
                    onBlur={() => setArmDel(false)}
                    onClick={() => {
                      if (!armDel) return setArmDel(true);
                      setArmDel(false);
                      // 只删正在看的这一版,接着看剩下最新的那版(从头看);只剩这一版的整部删掉,阅读页关上
                      if (world && deleteBookVersion(world.id, note.key, pos) === 'version') openBookReader(note.key);
                    }}
                  >
                    {armDel ? (nStored > 1 ? `再点一次删除第 ${pos + 1} 版` : '再点一次删除') : '删除'}
                  </button>
                )}
              </>
            )}
          </div>
        </header>
        <div
          className="bk-r-body"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          {note && unsaved.length > 0 && (
            <div className="bk-full" data-testid="book-full">
              <span>
                {`浏览器存储满了，${many ? `第 ${unsaved.join('、')} 版` : life ? '这一篇' : '这一部'}只在这一页里，刷新就没了。`}
                {nStored > 1 ? '可以删掉最早的第 1 版腾出地方，或者先「导出」存到电脑。' : '可以先「导出」存到电脑。'}
              </span>
              {nStored > 1 && (
                <button
                  data-act="book-free"
                  onClick={() => {
                    // 正在看的就是第 1 版:换成最新的那版,从头看
                    if (!world) return;
                    dropOldestVersion(world.id, note.key);
                    if (pos === 0) openBookReader(note.key);
                  }}
                >
                  删掉第 1 版再存
                </button>
              )}
            </div>
          )}
          {note && status?.stale && (
            <p className="bk-stale">
              {life
                ? `${many ? '这一版' : `这篇${lifeKind(scope)}`}写于历史改变之前（改过名、干预过历史、改过地形，或改过人物），可能对不上${status.why ? `：${status.why}` : ''}。`
                : `${many ? '这一版' : '这部史书'}写于历史改变之前(改过名、干预过历史或改过地形),可能对不上${status.why ? `:${status.why}` : ''}。`}
            </p>
          )}
          {chapters.length >= 2 && !writing && (
            <nav className="bk-toc" aria-label="目录">
              {chapters.map((c) => (
                <button key={c.id} className="bk-toc-row" onClick={() => document.getElementById(c.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                  <span className="bk-toc-n">{c.who ? '列传' : c.n}</span>
                  <span className="bk-toc-t">{c.who ? c.who.join('、') : c.t}</span>
                  <span className="bk-toc-y">{c.y}</span>
                </button>
              ))}
            </nav>
          )}
          <div className="bk-text">
            {blocks}
            {writing && <span className="bk-caret" />}
            {writing && !text && <p className="bk-wait">AI 正在读材料,马上开始写……</p>}
          </div>
        </div>
      </article>
    </div>
  );
}
