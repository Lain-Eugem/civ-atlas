/**
 * App 的键盘:Esc(先收起正在做的那件事,再取消选中)和快捷键动作(按键对照见 ./shortcuts.ts,
 * 什么时候不管按键见 ./useShortcuts.ts)。每个动作做什么照 App 现在的状态定,App 把要用的状态和函数传进来。
 */
import { useEffect } from 'react';
import { flushSync } from 'react-dom';
import type { World } from '../gen/world';
import type { Raster } from '../gen/raster';
import type { Civ } from '../gen/civ/types';
import { isTyping, useShortcuts } from './useShortcuts';
import { clearSelection, stepYear, togglePlayback } from './civView';
import { escapeCharacter } from './characterStore';
import { closeUpheaval, getUpUi, undoUpOp } from './upheavalStore';
import { cancelDraft, getMarkUi, stopPlacing } from './markStore';
import { getPolityPick, setPolityPick } from './Interventions';
import { getStepwise } from './stepwiseStore';
import { stepwiseNudge, stepwiseToggle } from './Stepwise';
import { replayStart } from './timelineLayout';
import { openJump } from './JumpYear';
import { DRAFT_SEG } from './Corners';
import { FILL_KEYS, type BaseId, type FillId, type MapLayer, type SatLook } from './mapLayers';
import { undoTerrainOp } from './editsStore';
import { redoLastEdit, undoLastEdit } from './undo';
import { openSaveMenu } from './SaveMenu';
import { copyCurrentLink } from './shareMoment';
import { collapseSide, expandSide, getSide } from './sideStore';
import { openShortcuts } from './ShortcutsDialog';
import { getTerrainTool } from './TerrainTools';
import type { Stage } from './stageStore';

/** App 传进来的:快捷键动作要看的状态和要调的函数 */
export interface AppShortcutsDeps {
  home: boolean;
  draft: boolean;
  stage: Stage;
  data: { world: World; raster: Raster } | null;
  civ: Civ | null;
  replayOn: boolean;
  narrow: boolean;
  /** 右下角的 + −(以看得见的地图中间为中心缩放) */
  zoomButton: (f: number) => void;
  applyLayer: (id: MapLayer) => void;
  applyMapView: (patch: Partial<{ base: BaseId; fill: FillId; sat: SatLook }>) => void;
}

export function useAppShortcuts({ home, draft, stage, data, civ, replayOn, narrow, zoomButton, applyLayer, applyMapView }: AppShortcutsDeps) {
  /** 建好的世界(不在首页、不在新建) */
  const world = stage === 'world';
  // Esc:先取消"在地图上点一个国家 / 城",再取消选中(在输入框里打字、焦点在下拉框里时不管,同快捷键)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isTyping(e.target)) return;
      if (escapeCharacter()) return;
      if (getUpUi().on) return closeUpheaval();
      const mk = getMarkUi();
      if (mk.placing) return stopPlacing();
      if (mk.draft) return cancelDraft();
      if (getPolityPick()) return setPolityPick(null);
      clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // 键盘快捷键(按键对照见 shortcuts.ts;光标在输入框里、弹窗开着时不管,见 useShortcuts.ts)。返回 false = 这一下不归快捷键管
  useShortcuts((a) => {
    if (home || !data) return false;
    const end = civ?.endYear ?? 0;
    // 有历史可放:建好的世界、长出了文明、不在回放世界形成
    const history = !draft && !!civ && civ.viable && !replayOn;
    // 宽屏、建好的世界:左边的卡片能收起(sideStore.ts);收起着要用卡片里的搜索框、存档时先展开
    const foldable = !narrow && !!world && stage === 'world';
    const sideHidden = () => foldable && getSide().collapsed && !getSide().peek;
    const showSide = () => sideHidden() && flushSync(expandSide);
    switch (a) {
      case 'play':
        if (!history) return false;
        // 逐年推演:播放 / 暂停只管这一段(停着的时候 = 接着演绎)
        if (getStepwise().on) stepwiseToggle();
        else togglePlayback(end, replayStart(end));
        return true;
      case 'back':
      case 'forward':
      case 'back100':
      case 'forward100':
        if (!history) return false;
        if (getStepwise().on) stepwiseNudge((a === 'back' || a === 'back100' ? -1 : 1) * (a.endsWith('100') ? 100 : 10));
        else stepYear(end, (a === 'back' || a === 'back100' ? -1 : 1) * (a.endsWith('100') ? 100 : 10));
        return true;
      case 'jump':
        // 时间轴上的年份变成输入框(JumpYear.tsx);时间轴藏着、锁着时不管
        return history && openJump();
      case 'zoomIn':
      case 'zoomOut':
        zoomButton(a === 'zoomIn' ? 1.5 : 1 / 1.5);
        return true;
      case 'layer1':
      case 'layer2':
      case 'layer3':
      case 'layer4': {
        const i = Number(a.slice(5)) - 1;
        if (draft) {
          const id = DRAFT_SEG[i];
          if (!id) return false;
          applyLayer(id);
          return true;
        }
        // 平常:1–4 = 填色(国家 / 民族 / 信仰 / 不填)
        const f = FILL_KEYS[i];
        if (!f || !data) return false;
        applyMapView({ fill: f });
        return true;
      }
      case 'layer5':
        // 5:复制这个世界的配方链接(以前当"第 5 个图层",可填色只有 4 档、新建只有 3 档,按 5 什么都没做)
        if (draft) return false;
        void copyCurrentLink();
        return true;
      case 'search': {
        showSide();
        const box = [...document.querySelectorAll<HTMLInputElement>('input.search-input')].find(
          (el) => !el.disabled && el.getClientRects().length > 0 && !el.closest('[inert]'),
        );
        if (!box) return false;
        box.focus();
        box.select();
        return true;
      }
      case 'undo':
      case 'redo':
        // 改地形工具开着:它自己管(撤销一笔);新建世界时 ⌘Z 也是撤销一笔地形
        if (getTerrainTool().on) return false;
        // 地形大事的卡片开着:撤销这一件里的最后一笔
        if (getUpUi().on) {
          if (a === 'undo') undoUpOp();
          return true;
        }
        if (draft) {
          if (a === 'undo') undoTerrainOp();
          return true;
        }
        if (a === 'undo') undoLastEdit();
        else redoLastEdit();
        return true;
      case 'save':
        if (draft) return false;
        showSide();
        return openSaveMenu();
      case 'side':
        // 和卡片上的收起按钮、收起后左上角的小按钮一样(卡片弹出来显示选中的东西时 = 收回去)
        if (!foldable) return false;
        if (sideHidden()) expandSide();
        else collapseSide();
        return true;
      case 'help':
        openShortcuts();
        return true;
    }
  });
}
