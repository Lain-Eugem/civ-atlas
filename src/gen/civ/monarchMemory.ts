/**
 * 君主的独立记忆库:重大事件影响他之后的判断。
 *
 * 两种写入者:
 *   1. 引擎事实(deriveEngineMemories):战败、亡国、饥荒、背盟……从编年史派生,确定性;
 *   2. 君主自述(cleanMemoryWrites):LLM 决策 JSON 里的 remember 字段,每回合 ≤2 条、每条 ≤60 字。
 *
 * 记忆只进提示词,不进引擎、不改数值;所以它不影响"同一串命令 → 同一段历史"的确定性口径。
 * 每条记忆都随回合日志落盘,导出会话时一并带走。
 */
import type { Civ } from './types';
import { buildChronicle, entryInvolves, entryYearLabel } from './story/chronicle';

export interface MemoryEntry {
  /** 这件事发生在哪一年(或写下的那一年) */
  year: number;
  kind: string;
  text: string;
  /** 0–1,越大越难忘;淘汰时先丢权重低、年份早的 */
  weight: number;
  source: 'engine' | 'self';
}

export interface MemoryBook {
  polityId: number;
  entries: MemoryEntry[];
  /** 变了几次(界面用来判断要不要重画) */
  revision: number;
}

/** 每位君主最多记几条;超出按权重 + 新旧淘汰 */
export const MEMORY_MAX = 16;
/** 每回合君主最多自己写几条、每条最长几字 */
export const MEMORY_WRITE_MAX = 2;
export const MEMORY_TEXT_MAX = 60;

export function memoryBook(polityId: number): MemoryBook {
  return { polityId, entries: [], revision: 0 };
}

/** 写一条进去(就地改),并按上限淘汰 */
export function addMemory(book: MemoryBook, entry: MemoryEntry): void {
  const text = entry.text.trim().slice(0, MEMORY_TEXT_MAX);
  if (!text) return;
  // 同年、同文不重复记(引擎事实每回合会重扫一遍)
  if (book.entries.some((e) => e.year === entry.year && e.text === text)) return;
  book.entries.push({ ...entry, text, weight: Math.max(0, Math.min(1, entry.weight)) });
  if (book.entries.length > MEMORY_MAX) {
    book.entries.sort((a, b) => b.weight - a.weight || b.year - a.year);
    book.entries.length = MEMORY_MAX;
  }
  book.entries.sort((a, b) => a.year - b.year);
  book.revision += 1;
}

/** 把 LLM 写的 remember 清洗成记忆;不合格的直接丢,不影响命令 */
export function cleanMemoryWrites(raw: unknown, year: number): MemoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: MemoryEntry[] = [];
  for (const item of raw.slice(0, MEMORY_WRITE_MAX)) {
    const text = typeof item === 'string' ? item : ((item as { text?: unknown })?.text as unknown);
    if (typeof text !== 'string' || !text.trim()) continue;
    const w = (item as { weight?: unknown })?.weight;
    out.push({
      year: Math.floor(year),
      kind: 'self',
      text: text.trim().slice(0, MEMORY_TEXT_MAX),
      weight: typeof w === 'number' && Number.isFinite(w) ? Math.max(0, Math.min(1, w)) : 0.6,
      source: 'self',
    });
  }
  return out;
}

/** 哪些大事值得记;权重 = 多难忘 */
const MEMORY_KINDS: Record<string, number> = {
  fall: 1,
  collapse: 1,
  split: 0.9,
  war: 0.8,
  famine: 0.7,
  plague: 0.7,
  revolt: 0.8,
  ally: 0.5,
  dynasty: 0.4,
};

/**
 * 从编年史派生"这一段日子里,这个国家碰上的大事"。
 * 调用方每回合给 [fromYear, toYear),避免把整段历史一次性灌进去。
 */
export function deriveEngineMemories(civ: Civ, polityId: number, fromYear: number, toYear: number): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const e of buildChronicle(civ)) {
    const y = Math.floor(e.year);
    if (y < fromYear || y >= toYear) continue;
    const w = MEMORY_KINDS[e.kind];
    if (w === undefined || !entryInvolves(e, polityId)) continue;
    const text = `${entryYearLabel(e)} ${e.text}`.trim().slice(0, MEMORY_TEXT_MAX);
    if (text) out.push({ year: y, kind: e.kind, text, weight: w, source: 'engine' });
  }
  return out;
}

/** 提示词里的记忆段(按权重取前几条,再按年份排;没有 = 空串) */
export function memoryText(book: MemoryBook | undefined, max = 8): string {
  if (!book || !book.entries.length) return '';
  const picked = [...book.entries].sort((a, b) => b.weight - a.weight || b.year - a.year).slice(0, max);
  picked.sort((a, b) => a.year - b.year);
  return ['## 你记得的事(这些会影响你的判断)', ...picked.map((e) => `- ${e.text}`)].join('\n');
}
