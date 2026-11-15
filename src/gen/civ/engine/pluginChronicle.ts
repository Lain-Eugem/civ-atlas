/**
 * 推演插件写的编年史(sim.chronicle@1):插件交模板和指代,「{国:a}亡于魔潮之年」+ { a: 3 };
 * 存下的是换成编号的字「{国:3}亡于魔潮之年」(Civ.simChronicle),显示时再换成名字,所以改名照样跟着变。
 */

/** 占位符认的几种 */
export const CHRONICLE_REFS = { 国: 'polity', 州: 'region', 城: 'settlement', 族: 'culture' } as const;
export type ChronicleRefKind = (typeof CHRONICLE_REFS)[keyof typeof CHRONICLE_REFS];

/** 一句最多几个字(不算占位符)、几个占位符;一个插件在一个世界里最多写几句 */
export const CHRONICLE_LIMITS = { chars: 80, refs: 8, lines: 2000 } as const;
/** 占位符里编号最多几位(存下的字按这个位数认);写入端和读回端共用,免得写进去 7 位编号、接着推读回时认不出 */
const REF_ID_DIGITS = 6;
const REF_ID_MAX = 10 ** REF_ID_DIGITS - 1;

/** 插件交的一句 */
export interface PluginChronicle {
  text: string;
  /** 模板里的指代 → 这一次推演里的编号(国、州、城、族) */
  refs?: Readonly<Record<string, number>>;
}

/** 存进历史的一句 */
export interface SimChronicleLine {
  year: number;
  /** 哪个插件写的 */
  by: string;
  text: string;
}

const TEMPLATE_REF = /\{([国州城族]):([^{}]*)\}/g;
const TEMPLATE_ONE = new RegExp(TEMPLATE_REF.source);
const STORED_REF = new RegExp(`\\{([国州城族]):(0|[1-9]\\d{0,${REF_ID_DIGITS - 1}})\\}`, 'g');
const REF_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
/** 控制字符、改书写方向的字,还有私用区(编年史的名字占位符用它) */
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩-]/;

/** 每种指代此刻有几个(编号要小于它) */
export type RefCount = (kind: ChronicleRefKind) => number;

const isRefChar = (k: string): k is keyof typeof CHRONICLE_REFS => Object.prototype.hasOwnProperty.call(CHRONICLE_REFS, k);

function checkId(kind: string, id: number, count: RefCount): void {
  if (!isRefChar(kind)) throw new Error(`认不出 {${kind}:…}`);
  const n = count(CHRONICLE_REFS[kind]);
  if (!(Number.isInteger(id) && id >= 0 && id < n)) throw new Error(`{${kind}:…} 指的 ${id} 不在 0 到 ${n - 1} 里`);
  // 写入端也卡住编号位数:只校验 id < n 的话,n 一旦比 STORED_REF 认得的位数还大,写出来的编号读回时会被当成"认不出的占位符"
  if (id > REF_ID_MAX) throw new Error(`{${kind}:…} 的编号不能超过 ${REF_ID_MAX}`);
}

function checkPlain(text: string, plain: number, refs: number): void {
  if (!text.length) throw new Error('编年史不能是空的');
  if (BAD_CHARS.test(text)) throw new Error('编年史里有控制字符或认不出的字');
  if (plain > CHRONICLE_LIMITS.chars) throw new Error(`一句编年史最多 ${CHRONICLE_LIMITS.chars} 个字(不算占位符)`);
  if (refs > CHRONICLE_LIMITS.refs) throw new Error(`一句编年史最多 ${CHRONICLE_LIMITS.refs} 个占位符`);
}

/** 插件交的一句 → 存下的字;不合规矩抛 Error(说哪里不对) */
export function fillChronicle(raw: unknown, count: RefCount): string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('编年史要是 { text, refs } 这样的对象');
  const { text, refs } = raw as { text?: unknown; refs?: unknown };
  if (typeof text !== 'string') throw new Error('编年史的 text 要是字');
  if (refs !== undefined && (refs === null || typeof refs !== 'object' || Array.isArray(refs))) throw new Error('编年史的 refs 要是一个对象');
  const map = (refs ?? {}) as Record<string, unknown>;
  let n = 0;
  const out = text.replace(TEMPLATE_REF, (_, kind: string, key: string) => {
    if (!REF_KEY.test(key)) throw new Error(`占位符 {${kind}:${key}} 的指代要是字母开头的名字`);
    const id = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
    if (typeof id !== 'number') throw new Error(`占位符 {${kind}:${key}} 在 refs 里没有编号`);
    checkId(kind, id, count);
    n++;
    return `{${kind}:${id}}`;
  });
  checkPlain(text, text.replace(TEMPLATE_REF, '').length, n);
  return out;
}

/** 存下的一句查一遍(读世界、接着推时);不合规矩抛 Error */
export function checkStoredChronicle(text: string, count: RefCount): void {
  let n = 0;
  for (const m of text.matchAll(STORED_REF)) {
    checkId(m[1], Number(m[2]), count);
    n++;
  }
  checkPlain(text, text.replace(STORED_REF, '').length, n);
  // 换成带括号的记号再找:去掉占位符以后前后的字拼起来不算
  if (TEMPLATE_ONE.test(text.replace(STORED_REF, '{}'))) throw new Error('编年史里有认不出的占位符');
}

/** 存下的一句换成给人看的字:name(种类, 编号) 给名字 */
export function chronicleText(text: string, name: (kind: ChronicleRefKind, id: number) => string): string {
  return text.replace(STORED_REF, (_, kind: keyof typeof CHRONICLE_REFS, id: string) => name(CHRONICLE_REFS[kind], Number(id)));
}

/** 存下的一句里指到的(按出现的先后) */
export function chronicleRefs(text: string): [ChronicleRefKind, number][] {
  return [...text.matchAll(STORED_REF)].map((m) => [CHRONICLE_REFS[m[1] as keyof typeof CHRONICLE_REFS], Number(m[2])]);
}
