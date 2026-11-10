/**
 * AI 统治者 demo:让 AI 扮演一个国家,一年(或几年)做一个决定,由推演引擎执行。
 *
 * 用法(在 civ-atlas 仓库根目录):
 *   node ai-ruler/.build/ai-ruler/run.js                        # 默认:种子 7、第 2500 年、12 回合 × 5 年;没有 Key 自动 mock
 *   node ai-ruler/.build/ai-ruler/run.js --mock                 # 明确用假 AI
 *   node ai-ruler/.build/ai-ruler/run.js --key sk-xxx --turns 20 --step 1
 *   node ai-ruler/.build/ai-ruler/run.js --provider bailian --key sk-xxx
 *   node ai-ruler/.build/ai-ruler/run.js --base-url http://127.0.0.1:11434/v1 --model qwen2.5
 *
 * 它只读引擎的公开 API:generateWorld / playCiv / playTurn,不碰浏览器、不改仓库源码。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PARAMS, generateWorld } from '../src/gen/world';
import type { Civ } from '../src/gen/civ/types';
import { DEFAULT_CIV_PARAMS } from '../src/gen/civ';
import { cleanIntervention, polityKey, type Intervention, type PlayState } from '../src/gen/edits';
import { nameAt } from '../src/ai/prompts/rewrite';
import { playCiv, playTurn } from '../src/gen/civ/play';
import { polityAlive } from '../src/gen/civ/growth';
import { rulerAt } from '../src/gen/civ/story/peopleInfo';
import { buildChronicle, entryInvolves } from '../src/gen/civ/story/chronicle';
import { buildBriefing, sizesAt, neighborsOf, activeWars, ivText, entryLine, alivePolities } from './lib/briefing';
import { askLlm, mockDecision, parseDecision, type Decision, type LlmSettings } from './lib/decide';

interface Options {
  seed: number;
  year: number;
  turns: number;
  step: number;
  polity?: number;
  provider: 'deepseek' | 'bailian';
  model: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  mock: boolean;
  dryRun: boolean;
  out: string;
}

const PRESETS = new Set(['expand', 'hold', 'trade', 'peace']);
const FOCI = new Set(['production', 'transport', 'information', 'administration', 'mobilization']);

function parseArgs(argv: string[]): Options {
  const o: Options = {
    seed: 7,
    year: 2500,
    turns: 12,
    step: 5,
    provider: 'deepseek',
    model: '',
    baseUrl: '',
    apiKey: '',
    temperature: 0.7,
    mock: false,
    dryRun: false,
    out: 'ai-ruler/out',
  };
  const take = (i: number): string => {
    const v = argv[i];
    if (v === undefined) throw new Error(`参数 ${argv[i - 1]} 后面缺一个值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = (name: string): number => {
      const n = Number(take(++i));
      if (!Number.isInteger(n)) throw new Error(`${name} 要整数`);
      return n;
    };
    if (a === '--seed') o.seed = num('--seed');
    else if (a === '--year') o.year = num('--year');
    else if (a === '--turns') o.turns = num('--turns');
    else if (a === '--step') o.step = num('--step');
    else if (a === '--polity') o.polity = num('--polity');
    else if (a === '--provider') o.provider = take(++i) as Options['provider'];
    else if (a === '--model') o.model = take(++i);
    else if (a === '--base-url') o.baseUrl = take(++i);
    else if (a === '--key') o.apiKey = take(++i);
    else if (a === '--temperature') o.temperature = Number(take(++i));
    else if (a === '--out') o.out = take(++i);
    else if (a === '--mock') o.mock = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '-h' || a === '--help') {
      console.log('参数:--seed 7 --year 2500 --turns 12 --step 5 --polity N --provider deepseek|bailian --model 名字 --base-url 地址 --key KEY --mock --dry-run --out 目录');
      process.exit(0);
    } else throw new Error(`不认识的参数:${a}`);
  }
  if (o.provider !== 'deepseek' && o.provider !== 'bailian') throw new Error('--provider 只能是 deepseek 或 bailian');
  if (!o.model) o.model = o.provider === 'bailian' ? 'qwen-plus' : 'deepseek-chat';
  if (!o.baseUrl) o.baseUrl = o.provider === 'bailian' ? 'https://dashscope.aliyuncs.com/compatible-mode/v1' : 'https://api.deepseek.com';
  if (!o.apiKey) o.apiKey = (o.provider === 'bailian' ? process.env.DASHSCOPE_API_KEY : process.env.DEEPSEEK_API_KEY) ?? '';
  if (!o.apiKey && /^https?:\/\/(127\.0\.0\.1|localhost)/.test(o.baseUrl)) o.apiKey = 'local'; // 本地模型不校验 Key
  if (!o.apiKey) o.mock = true; // 没有 Key 就悄悄退到 mock,保证 demo 一定能跑
  if (o.turns < 1) throw new Error('--turns 至少 1');
  if (o.step < 1) throw new Error('--step 至少 1');
  return o;
}

/** AI 的 JSON 命令 → 引擎认的干预(a 永远是我们自己,b 用 P 编号换算成稳定键) */
function buildCommands(civ: Civ, meId: number, year: number, raw: unknown[]): { commands: Intervention[]; rejects: { raw: unknown; why: string }[] } {
  const myKey = polityKey(civ, meId);
  const alive = new Set(alivePolities(civ, year).map((p) => p.id));
  const targets = (v: unknown): number | null => {
    const n = typeof v === 'string' && /^P?\d+$/.test(v) ? Number(v.replace(/^P/i, '')) : typeof v === 'number' ? v : NaN;
    return Number.isInteger(n) && n >= 0 && alive.has(n) && n !== meId ? n : null;
  };
  const until = (v: unknown): number | undefined => {
    if (v === undefined || v === null) return undefined;
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
    if (!Number.isInteger(n)) return undefined;
    return Math.min(65535, Math.max(year + 1, n));
  };
  const commands: Intervention[] = [];
  const rejects: { raw: unknown; why: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      rejects.push({ raw: item, why: '不是对象' });
      continue;
    }
    const o = item as Record<string, unknown>;
    const kind = typeof o.kind === 'string' ? o.kind : '';
    let v: Record<string, unknown> | null = null;
    if (kind === 'policy') {
      const preset = o.preset === undefined ? undefined : String(o.preset);
      if (preset !== undefined && !PRESETS.has(preset)) {
        rejects.push({ raw: item, why: `preset 只能是 ${[...PRESETS].join('/')}` });
        continue;
      }
      v = { kind, from: year, a: myKey };
      if (preset) v.preset = preset;
      for (const k of ['war', 'expand', 'coast', 'peace'] as const) {
        const n = o[k];
        if (typeof n === 'number' && Number.isFinite(n)) v[k] = Math.max(-50, Math.min(50, Math.round(n)));
      }
      if (typeof o.focus === 'string' && FOCI.has(o.focus)) v.focus = o.focus;
    } else if (kind === 'declare' || kind === 'ally') {
      const b = targets(o.b);
      if (b === null) {
        rejects.push({ raw: item, why: 'b 不是今年在世的国家编号' });
        continue;
      }
      v = { kind, from: year, a: myKey, b: polityKey(civ, b) };
      if (kind === 'ally') {
        const u = until(o.until);
        if (u !== undefined) v.until = u;
      }
    } else if (kind === 'halt') {
      v = { kind, from: year, a: myKey };
      const u = until(o.until);
      if (u !== undefined) v.until = u;
    } else if (kind === 'boost') {
      v = { kind, from: year, a: myKey };
      if (o.mul !== undefined) {
        const mul = Number(o.mul);
        if (mul !== 3 && mul !== 10) {
          rejects.push({ raw: item, why: 'mul 只能是 3 或 10(或者不写)' });
          continue;
        }
        v.mul = mul;
      }
      const u = until(o.until);
      if (u !== undefined) v.until = u;
    } else {
      rejects.push({ raw: item, why: `demo 只支持 policy/declare/ally/halt/boost,不认识 ${kind || '(空)'}` });
      continue;
    }
    const clean = cleanIntervention(v);
    if (!clean) rejects.push({ raw: item, why: '引擎校验没过' });
    else commands.push(clean);
  }
  return { commands, rejects };
}

function markdown(opts: Options, meName: string, log: string[]): string {
  return [
    `# AI 统治者 demo · ${meName}`,
    '',
    `- 世界种子:${opts.seed};起始年:${opts.year};回合:${opts.turns} × 每回合 ${opts.step} 年`,
    `- 模式:${opts.mock ? 'mock(假 AI)' : `${opts.provider} / ${opts.model}`}`,
    `- 生成时间:${new Date().toISOString()}`,
    '',
    ...log,
  ].join('\n');
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = performance.now();

  // 1. 世界 + 推到起始年(停在年初)
  const world = generateWorld({ ...DEFAULT_PARAMS, seed: opts.seed });
  const params = { ...DEFAULT_CIV_PARAMS };
  const play0: PlayState = { year: opts.year, commands: [] };
  let civ = playCiv(world, params, play0);
  let play = play0;
  const tInit = performance.now();
  console.log(`世界 ${world.elevation.length} 块地;推演到第 ${opts.year} 年用了 ${((tInit - t0) / 1000).toFixed(1)} 秒`);

  // 2. 选国家:默认这年最大的那个
  const size = sizesAt(civ, opts.year);
  const candidates = civ.polities.filter((p) => polityAlive(p, opts.year) && (size.get(p.id) ?? 0) > 0).sort((a, b) => (size.get(b.id) ?? 0) - (size.get(a.id) ?? 0) || a.id - b.id);
  if (!candidates.length) {
    console.error(`第 ${opts.year} 年还没有国家,把 --year 调大一点(比如 2000、2500)`);
    process.exit(1);
  }
  const meId = opts.polity ?? candidates[0].id;
  const me = civ.polities[meId];
  if (!me || !polityAlive(me, opts.year) || !(size.get(meId) ?? 0)) {
    console.error(`第 ${opts.year} 年没有 P${meId} 这个国家,可选:${candidates.slice(0, 12).map((p) => `P${p.id}(${size.get(p.id)} 州)`).join('、')}`);
    process.exit(1);
  }
  const meName = nameAt(me, opts.year);

  const llm: LlmSettings = {
    label: opts.provider === 'bailian' ? '阿里云百炼' : 'DeepSeek',
    baseUrl: opts.baseUrl,
    model: opts.model,
    apiKey: opts.apiKey,
    temperature: opts.temperature,
  };
  console.log(`扮演:P${meId} ${meName}(第 ${opts.year} 年 ${size.get(meId)} 州);模式:${opts.mock ? 'mock 假 AI(不用 Key)' : `${llm.label} ${llm.model}`}`);
  if (opts.mock) console.log('提示:想用真 AI,加 --key(或设 DEEPSEEK_API_KEY / DASHSCOPE_API_KEY);换本地模型用 --base-url。');

  // 3. 一年一年地决定
  const log: string[] = [];
  let lastYear = opts.year;
  const timer = performance.now();
  for (let turn = 1; turn <= opts.turns; turn++) {
    const Y = play.year;
    const brief = buildBriefing(civ, play, meId);
    if (!brief.alive) {
      const line = `## 第 ${turn} 回合(第 ${Y} 年)\n\n国家 P${meId} 已经不存在了,demo 到此结束。\n`;
      log.push(line);
      console.log(`第 ${Y} 年:P${meId} 已亡,结束`);
      break;
    }
    if (turn === 1 && opts.dryRun) {
      console.log('\n=== 第一回合给 AI 的局势简报 ===\n');
      console.log(brief.text);
      console.log('\n=== --dry-run:只打印简报,没有调 AI、没有推演 ===');
      return;
    }

    // AI 做决定
    let decision: Decision;
    let usageText = '';
    if (opts.mock) {
      const ruler = rulerAt(civ, meId, Y);
      decision = mockDecision({
        briefing: brief,
        ruler: ruler ? { name: ruler.name, leanings: ruler.leanings } : null,
        neighbors: neighborsOf(civ, meId, Y),
        wars: activeWars(civ, meId, Y).length,
        turn,
      });
    } else {
      const { text, usage } = await askLlm(brief.text, llm);
      decision = parseDecision(text);
      usageText = usage ? ` token ${JSON.stringify(usage)}` : '';
    }

    // 决定 → 命令 → 推演
    const { commands, rejects } = buildCommands(civ, meId, Y, decision.commands);
    const sizeBefore = brief.size;
    const step = playTurn(world, civ, params, play, commands, opts.step);
    const endYear = step.play.year;
    const sizeAfter = sizesAt(step.civ, endYear).get(meId) ?? 0;
    const warsNow = activeWars(step.civ, meId, endYear).length;
    const chronicle = buildChronicle(step.civ);
    // 这 5 年里「开始」或「结束」的大事(只看我国和战争),不只是第 Y 年当年的
    const newEvents = chronicle.filter((e) => {
      const s = Math.floor(e.year);
      const d = Math.floor(e.end);
      const started = s >= Y && s <= endYear;
      const ended = d >= Y && d <= endYear;
      return (started || ended) && (entryInvolves(e, meId) || e.kind === 'war');
    });

    civ = step.civ;
    play = step.play;
    lastYear = play.year;

    // 打印 + 记录
    const cmdText = commands.length ? commands.map((v) => ivText(civ, v)).join('、') : '(什么也没做)';
    console.log(`第 ${Y}→${play.year} 年 | ${decision.reason} | 命令:${cmdText}${rejects.length ? ` | 拒收 ${rejects.length} 条` : ''} | 州 ${sizeBefore}→${sizeAfter} | 仗 ${warsNow} 场${usageText}`);
    for (const r of rejects) console.log(`  拒收:${JSON.stringify(r.raw)} —— ${r.why}`);
    const lines = [
      `## 第 ${turn} 回合:第 ${Y} 年 → 第 ${play.year} 年`,
      '',
      `- AI 理由:${decision.reason}`,
      `- 下的命令:${cmdText}`,
      ...(rejects.length ? [`- 被拒收:${rejects.map((r) => JSON.stringify(r.raw) + `(${r.why})`).join(';')}`] : []),
      `- 结果:P${meId} 州数 ${sizeBefore} → ${sizeAfter};正在打的仗 ${warsNow} 场`,
      ...(newEvents.length ? ['- 这一年的事:', ...newEvents.slice(0, 10).map((e) => `  - ${entryLine(e)}`)] : []),
      '',
    ];
    log.push(lines.join('\n'));
  }

  const elapsed = ((performance.now() - timer) / 1000).toFixed(1);
  const finalSize = sizesAt(civ, play.year).get(meId) ?? 0;
  const summary = [
    '## 收尾',
    '',
    `- 结束在第 ${lastYear} 年;P${meId} ${meName} 还剩 ${finalSize} 州;共下了 ${play.commands.length} 条命令`,
    `- 推演 + 决策用时 ${elapsed} 秒`,
    '',
  ].join('\n');
  log.push(summary);
  console.log(`\n结束:第 ${lastYear} 年,P${meId} ${meName} 剩 ${finalSize} 州,命令 ${play.commands.length} 条,用时 ${elapsed} 秒`);

  // 4. 写日志
  const dir = resolve(process.cwd(), opts.out);
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `run-s${opts.seed}-y${opts.year}-${opts.turns}x${opts.step}-${opts.mock ? 'mock' : opts.provider}.md`);
  writeFileSync(file, markdown(opts, meName, log), 'utf8');
  console.log(`日志:${file}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  // 不用 process.exit:fetch 的连接还在关闭时强退,Node 会报 libuv Assertion failed。
  // 设 exitCode 让事件循环自己收尾,进程仍然以 1 退出。
  process.exitCode = 1;
});


