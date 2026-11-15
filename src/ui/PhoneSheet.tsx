/**
 * 手机(窄屏)底部的世界卡片:没选东西时一直在屏幕底,两档 ——
 *
 *   收起(默认)  拖动条、搜索框、一行世界名 +"我的世界"
 *   拉到顶       搜索框、世界名 +"更多"、四个大按钮(我的世界、存档、导出、编年史)、整个世界(国家、民族、最近大事、我的干预、这颗星球)
 *
 * 往上拖 / 点拖动条 / 点搜索框 → 拉到顶;往下拖 / 点拖动条 → 收起(拖着的时候下面的内容跟着露出来)。搜索框里有字时下面换成搜索结果。
 * 选中了东西:详情卡片(Inspector)从屏幕底升起盖住这张(App 这时不渲染它)。
 * 时间轴胶囊浮在卡片上面(拉到顶时藏起来);右上竖着三个毛玻璃按钮(图层、地球、助手),见 Corners.tsx 的 PhoneButtons。
 * 零件(搜索、世界名、"更多"菜单、整个世界)和宽屏的侧栏共用,见 Sidebar.tsx。
 */
import { useEffect, useRef, useState } from 'react';
import { SaveMenu } from './SaveMenu';
import { ExportMenu, type ExportMenuProps } from './ExportMenu';
import { openOverview } from './overviewStore';
import { setSheetDrag, setWorldSheet, usePanel } from './panelStore';
import { VELOCITY_MS, releaseVelocity, worldSnap } from './gestures';
import { phoneSheet } from './flyTo';
import { Icon } from './icons';
import { openStepDialog } from './stepwiseStore';
import { SearchField, SearchResults, WorldHome, WorldMoreMenu, useSearch, useWorldInfo, type SidebarProps } from './Sidebar';

export type PhoneSheetProps = Omit<SidebarProps, 'inspectorSlot'> & {
  /** 拉到顶时"导出"按钮要的东西 */
  exp: ExportMenuProps;
};

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

export function PhoneSheet(p: PhoneSheetProps) {
  const { world: snap } = usePanel();
  const s = useSearch(p.civ);
  const { title, sub, step } = useWorldInfo(p.civ, p.data);
  const d = useWorldDrag(snap);
  const full = snap === 'full';
  // 搜索框里有字时卡片拉到顶(结果有地方放;手机键盘弹出来也不挡)
  useEffect(() => {
    if (s.searching) setWorldSheet('full');
  }, [s.searching]);
  const ready = !!p.data && !p.generating;
  return (
    <>
      <section
        ref={d.ref}
        className={`psheet ps-${snap}${d.top !== null ? ' dragging' : ''}`}
        style={d.top !== null ? { top: d.top } : undefined}
        aria-label="世界"
        onPointerDown={(e) => {
          stop(e);
          d.down(e);
        }}
        onPointerMove={(e) => {
          stop(e);
          d.move(e);
        }}
        onPointerUp={d.up}
        onPointerCancel={d.up}
        onClick={stop}
        onDoubleClick={stop}
      >
        <button className="sheet-grip" data-act="world-sheet" aria-label={full ? '收起' : '展开'} aria-expanded={full} onClick={() => setWorldSheet(full ? 'peek' : 'full')}>
          <i aria-hidden="true" />
        </button>
        <div className="ps-head">
          <SearchField s={s} onFocus={() => setWorldSheet('full')} />
          {!full && (
            <div className="ps-row">
              <button className="ps-title" data-act="overview" onClick={() => openOverview()} title="世界概览:国家、编年史、干预、世界参数">
                <b className="sb-name">{title}</b>
                {/* 逐年推演:标题旁只写"逐年推演",右边「我的世界」换成「存回推演模式」(「我的世界」在拉开后的那排按钮里) */}
                <span className="sb-sub">{step ? '逐年推演' : sub}</span>
              </button>
              {step ? (
                <button className="ps-link" data-act="step-save" onClick={() => openStepDialog({ kind: 'save' })}>
                  存回推演模式
                </button>
              ) : (
                <button className="ps-link" data-act={p.homeLabel ? 'gallery-back' : 'home'} onClick={p.onHome} title={p.homeLabel ? undefined : '我存过的世界、新建世界'}>
                  {p.homeLabel ?? '我的世界'}
                </button>
              )}
            </div>
          )}
        </div>
        {(full || d.top !== null) && (
          <div className="ps-body">
            {s.searching ? (
              <SearchResults q={s.q} hits={s.hits} active={s.active} onActive={s.setActive} onPick={s.pick} />
            ) : (
              <>
                {full && (
                  <div className="ps-world">
                    <button className="ps-title big" data-act="overview" onClick={() => openOverview()} title="世界概览:国家、编年史、干预、世界参数">
                      <b className="sb-name">{title}</b>
                      <span className="sb-sub">{sub}</span>
                    </button>
                    <WorldMoreMenu
                      civ={p.civ}
                      className="ps-more"
                      onBook={() => {
                        // 写史书在后台进行,进度在右上(卡片拉到顶时右上的按钮藏着)
                        setWorldSheet('peek');
                      }}
                    />
                  </div>
                )}
                <div className="ps-tiles">
                  <button className="ps-tile" data-act={p.homeLabel ? 'gallery-back' : 'home'} onClick={p.onHome} title={p.homeLabel ? undefined : '我存过的世界、新建世界'}>
                    <Icon name={p.homeLabel ? 'image' : 'grid'} size={20} />
                    {p.homeLabel ?? '我的世界'}
                  </button>
                  <SaveMenu ready={ready} icon={<Icon name="save" size={20} />} />
                  <ExportMenu {...p.exp} icon={<Icon name="export" size={20} />} />
                  <button
                    className="ps-tile"
                    data-act="chronicle"
                    disabled={!p.civ || !p.civ.viable}
                    onClick={() => openOverview('chronicle', { polity: null })}
                    title="按年份看全部大事"
                  >
                    <Icon name="book" size={20} />
                    编年史
                  </button>
                </div>
                <WorldHome {...p} />
              </>
            )}
          </div>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// 拖动条、搜索框和世界名那一截上下拖

function useWorldDrag(snap: 'peek' | 'full') {
  const ref = useRef<HTMLElement>(null);
  /** 拖动中卡片上边的 y(相对界面;不在拖 = null,按 CSS 停在收起 / 拉到顶) */
  const [top, setTop] = useState<number | null>(null);
  const press = useRef<{ id: number; y0: number; top0: number; moved: boolean; samples: { y: number; t: number }[] } | null>(null);
  const geo = () => phoneSheet(ref.current?.offsetParent?.clientHeight ?? window.innerHeight);
  const clampTop = (y: number) => {
    const g = geo();
    return Math.max(g.fullTop - 24, Math.min(g.peekTop + 24, y));
  };
  const down = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const t = e.target as HTMLElement;
    // 搜索框(和别的能输入、能选字的地方)里按下:留给输入框自己(选字、移光标、弹手机键盘),别当成拖卡片;
    // 拖起来时下面还会 blur 掉焦点,不排除的话在搜索框里一滑键盘就收了
    if (t.closest('input, textarea, select, [contenteditable="true"], [role="searchbox"], [role="textbox"]')) return;
    // 拖动条、搜索框那一截、世界名那一行能拖(拉到顶时下面的列表留给滚动)
    if (!t.closest('.sheet-grip, .ps-head, .ps-world') || t.closest('.save-menu, .pm-menu')) return;
    press.current = { id: e.pointerId, y0: e.clientY, top0: el.offsetTop, moved: false, samples: [{ y: e.clientY, t: performance.now() }] };
  };
  const move = (e: React.PointerEvent) => {
    const p = press.current;
    const el = ref.current;
    if (!p || p.id !== e.pointerId || !el) return;
    const dy = e.clientY - p.y0;
    if (!p.moved) {
      if (Math.abs(dy) < 6) return;
      p.moved = true;
      setSheetDrag(true);
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 合成的指针事件没有真的指针 */
      }
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
    const now = performance.now();
    p.samples.push({ y: e.clientY, t: now });
    while (p.samples.length > 2 && now - p.samples[0].t > VELOCITY_MS) p.samples.shift();
    setTop(clampTop(p.top0 + dy));
  };
  const up = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    if (!p.moved) return;
    setSheetDrag(false);
    const vy = releaseVelocity(p.samples, e.clientY, performance.now());
    setWorldSheet(worldSnap(clampTop(p.top0 + e.clientY - p.y0), vy, geo()));
    setTop(null);
  };
  // 换了档(点拖动条、点搜索框):拖到一半的位置作废
  useEffect(() => setTop(null), [snap]);
  // 拖到一半卡片没了(比如别处选中了东西):"正在拖"的标记收回来,时间轴胶囊别一直藏着
  useEffect(
    () => () => {
      if (press.current?.moved) setSheetDrag(false);
    },
    [],
  );
  return { ref, top, down, move, up };
}
