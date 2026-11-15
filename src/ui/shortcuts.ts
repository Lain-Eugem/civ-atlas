/**
 * 键盘快捷键(电脑上;手机、平板没有键盘,不受影响):按键 → 动作的换算,和界面上怎么写这个键。
 *
 *   空格        播放 / 暂停历史
 *   ← →         往前 / 往后 10 年,按住 Shift 100 年
 *   + −         放大 / 缩小地图(和右下的 + − 一样)
 *   1 2 3 4     填色:国家 / 民族 / 信仰 / 不填(新建世界时 1–3:地形 / 实景 / 高程)
 *   5           复制这个世界的配方链接(和存档菜单、国家卡片同一套,见 shareMoment.tsx 的 copyCurrentLink)
 *   /           光标跳进搜索框
 *   ⌘Z / ⇧⌘Z    撤销 / 重做最近一次修改(Windows 上是 Ctrl + Z / Ctrl + Shift + Z,Ctrl + Y 也是重做)
 *   ⌘S          打开「存档」菜单(世界本来就自动存着;不弹浏览器自己的"存储网页")
 *   ⌘\          收起 / 展开左边的卡片
 *   ?           快捷键一览
 *   Esc         照旧:取消选中、关掉弹出的东西(各处自己处理,不在这里)
 *
 * 字母、数字、空格按键位认(KeyboardEvent.code),中文输入法开着、法文键盘也一样;+ − / ? 按键帽上的字认(见 charOf)。⌘ 和 Ctrl 两边都认。
 * 留给浏览器的不占:⌘F(在页面里查找)、⌘+ ⌘−(整页放大)、⌘数字(切标签页)。
 * 什么时候不管(光标在输入框里、弹窗开着……)、每个动作具体做什么在 useShortcuts.ts / App.tsx。
 */

export type ShortcutAction =
  | 'play'
  | 'back'
  | 'forward'
  | 'back100'
  | 'forward100'
  | 'jump'
  | 'zoomIn'
  | 'zoomOut'
  | 'layer1'
  | 'layer2'
  | 'layer3'
  | 'layer4'
  | 'layer5'
  | 'search'
  | 'undo'
  | 'redo'
  | 'save'
  | 'side'
  | 'help';

/** 界面上要写出来的键:上面的动作,外加各处自己处理的 Esc */
export type ShortcutKey = ShortcutAction | 'esc';

/** KeyboardEvent 里用得到的几项(单测里直接给对象) */
export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const LAYER_CODES: Record<string, ShortcutAction> = {
  Digit1: 'layer1',
  Digit2: 'layer2',
  Digit3: 'layer3',
  Digit4: 'layer4',
  Digit5: 'layer5',
  Numpad1: 'layer1',
  Numpad2: 'layer2',
  Numpad3: 'layer3',
  Numpad4: 'layer4',
  Numpad5: 'layer5',
};

/** 符号键:打出来的字没法用(输入法给的「、」、死键之类)时,按键位当美式键盘上的字 */
const CODE_CHARS: Record<string, [string, string]> = {
  Equal: ['=', '+'],
  Minus: ['-', '_'],
  Slash: ['/', '?'],
  NumpadAdd: ['+', '+'],
  NumpadSubtract: ['-', '-'],
  NumpadDivide: ['/', '/'],
};

/**
 * 这一下打出来的是哪个字(用来认 + − / ?):
 * 平常就是 key(各种键盘布局按键帽上的字认,比如德文键盘的 + 是单独一个键、/ 是 Shift + 7);
 * 全角的「？」「＋」当半角;中文标点(「、」)和不是一个字的(死键)按键位认
 */
function charOf(e: KeyLike): string {
  const k = e.key;
  if (k.length === 1) {
    const c = k.charCodeAt(0);
    if (c >= 0xff01 && c <= 0xff5e) return String.fromCharCode(c - 0xfee0);
    if (c < 0x3000 || c > 0x303f) return k;
  }
  const m = CODE_CHARS[e.code];
  return m ? m[e.shiftKey ? 1 : 0] : '';
}

/** 这一下按键是哪个快捷键(不是 = null) */
export function matchShortcut(e: KeyLike): ShortcutAction | null {
  if (e.altKey) return null;
  if (e.metaKey || e.ctrlKey) {
    if (e.code === 'KeyZ') return e.shiftKey ? 'redo' : 'undo';
    if (e.code === 'KeyY' && e.ctrlKey && !e.metaKey && !e.shiftKey) return 'redo';
    if (e.shiftKey) return null;
    if (e.code === 'KeyS') return 'save';
    if (e.code === 'Backslash') return 'side';
    return null;
  }
  if (e.key === 'ArrowLeft') return e.shiftKey ? 'back100' : 'back';
  if (e.key === 'ArrowRight') return e.shiftKey ? 'forward100' : 'forward';
  // + 在美式键盘上是 Shift + =,= 也算;Shift 只在这几个符号上有用,别的键按着 Shift 不管
  const ch = charOf(e);
  if (ch === '+' || ch === '=') return 'zoomIn';
  if (ch === '-') return 'zoomOut';
  if (ch === '/') return 'search';
  if (ch === '?') return 'help';
  if (e.shiftKey) return null;
  if (e.code === 'Space') return 'play';
  // G 按键位认(中文输入法、别的键盘布局打出来的字不一样)
  if (e.code === 'KeyG') return 'jump';
  // 数字按键位认:法文键盘上不按 Shift 打出来的是 é 之类,中文、日文输入法也一样
  return LAYER_CODES[e.code] ?? null;
}

/** 苹果的电脑 / 平板:修饰键写成 ⌘ ⇧;别的写成 Ctrl、Shift */
export function isMacLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || nav.userAgent || '');
}

/** 界面上这个键怎么写:提示框、快捷键一览 */
export function keyLabel(k: ShortcutKey, mac = isMacLike()): string {
  const mod = (c: string) => (mac ? `⌘${c}` : `Ctrl+${c}`);
  switch (k) {
    case 'play':
      return '空格';
    case 'back':
      return '←';
    case 'forward':
      return '→';
    case 'back100':
      return mac ? '⇧←' : 'Shift+←';
    case 'forward100':
      return mac ? '⇧→' : 'Shift+→';
    case 'jump':
      return 'G';
    case 'zoomIn':
      return '+';
    case 'zoomOut':
      return '−';
    case 'layer1':
      return '1';
    case 'layer2':
      return '2';
    case 'layer3':
      return '3';
    case 'layer4':
      return '4';
    case 'layer5':
      return '5';
    case 'search':
      return '/';
    case 'undo':
      return mod('Z');
    case 'redo':
      return mac ? '⇧⌘Z' : 'Ctrl+Shift+Z';
    case 'save':
      return mod('S');
    case 'side':
      return mod('\\');
    case 'help':
      return '?';
    case 'esc':
      return 'Esc';
  }
}

/** 快捷键一览:三组,每行一件事 + 它的键 */
export const SHORTCUT_GROUPS: readonly { title: string; rows: readonly { text: string; keys: readonly ShortcutKey[] }[] }[] = [
  {
    title: '时间',
    rows: [
      { text: '播放 / 暂停', keys: ['play'] },
      { text: '往前 / 往后 10 年', keys: ['back', 'forward'] },
      { text: '往前 / 往后 100 年', keys: ['back100', 'forward100'] },
      { text: '输入年份，跳到那一年', keys: ['jump'] },
    ],
  },
  {
    title: '地图',
    rows: [
      { text: '放大 / 缩小', keys: ['zoomIn', 'zoomOut'] },
      { text: '填色：国家、民族、信仰、不填', keys: ['layer1', 'layer2', 'layer3', 'layer4'] },
      { text: '收起 / 展开左边的卡片', keys: ['side'] },
      { text: '取消选中，关掉弹出的东西', keys: ['esc'] },
    ],
  },
  {
    title: '世界',
    rows: [
      { text: '搜索', keys: ['search'] },
      { text: '复制这个世界的配方链接', keys: ['layer5'] },
      { text: '撤销 / 重做', keys: ['undo', 'redo'] },
      { text: '存档', keys: ['save'] },
      { text: '快捷键一览', keys: ['help'] },
    ],
  },
];
