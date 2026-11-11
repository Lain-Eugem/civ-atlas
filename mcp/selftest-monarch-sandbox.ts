/**
 * 君主沙盒四功能自检(不联网):
 *   1. 首次引导的落点:两把 Key 的配置形状 + features 默认值;
 *   2. 双开关:LLM 关 → 明确报错;仅 Jev(mock)→ 能推回合;双关 → 纯 turnStep;
 *   3. 角色卡:确定性、自然生物 persona、玩家改卡、换君主重建;记忆上限与清洗;
 *   4. 提示词分层:system 不含年份、逐回合一致;user 含年份/逐州表/情报;
 *   5. 高影响命令审核:规则路径的放行/降级;Jev 不可达时降级不阻塞;
 *   6. 渗透:intel 干预进命令史、result 随命令落盘、回放一致、情报按字段遮蔽。
 *
 * 运行: node mcp/.build/mcp/selftest-monarch-sandbox.js
 */
import { cleanIntervention } from '../src/gen/edits';
import { createWorld, getSession, openSession, stateGet, submitOrders, turnStep } from './engine';
import { buildMonarchBriefs, type MonarchBrief } from '../src/gen/civ/monarch';
import { cardIsCurrent, cleanCardInput, monarchCard } from '../src/gen/civ/monarchCard';
import { MEMORY_MAX, addMemory, cleanMemoryWrites, memoryBook } from '../src/gen/civ/monarchMemory';
import { foreignIntel, regionTable } from '../src/gen/civ/monarchIntel';
import { monarchMessages } from './prompt';
import { auditByRule } from './monarch-audit';
import { resolveIntel } from './intel';
import { cleanOrders } from './orders';
import { monarchPlan, monarchCommit, monarchRound, monarchStatus, setupMonarch, setMonarchCard, verifySession } from './monarch';
import { pettyRound, pettySetup } from './petty';

let pass = 0;
let fail = 0;

function ok(cond: boolean, name: string, detail?: unknown): void {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}`);
    if (detail !== undefined) console.log('       ' + JSON.stringify(detail).slice(0, 400));
  }
}

async function main(): Promise<void> {
  console.log('== 君主沙盒四功能自检(mock,不联网)==');
  const started = Date.now();
  const world = createWorld({ seed: 7, params: { cells: 12000 } });
  const opened = openSession({ worldId: world.id, startYear: 1200, stepYears: 5, maxRounds: 6, mode: 'monarch' });
  const s = getSession(opened.summary.sessionId);
  ok(s.features.llm === true && s.features.jev === false, 'features 默认:LLM 开、Jev 关', s.features);

  const state = stateGet(s);
  const alive = state.polities as { id: number; name: string; size: number; key: string }[];
  ok(alive.length >= 2, '第 1200 年有至少两国', alive.length);
  const me = alive[0]!;
  const other = alive[1]!;

  /* ---------- 角色卡 ---------- */
  const card = monarchCard(s.civ, me.id, 1200)!;
  ok(!!card && card.polityId === me.id && card.key === me.key, '角色卡带国家编号与稳定键', card);
  ok(card.persona.includes('会老') && card.persona.includes('不是"国家意志"'), 'persona 写明"自然生物/不是国家意志"');
  ok(cardIsCurrent(s.civ, card, 1200), '当年君主与卡一致');
  const again = monarchCard(s.civ, me.id, 1200)!;
  ok(JSON.stringify(again) === JSON.stringify(card), '同一世界同一君主 → 同一张卡(确定性)');
  ok(!cardIsCurrent(s.civ, { ...card, name: '不存在的人' }, 1200), '换了名字 → 卡失效(触发重建)');
  const edited = cleanCardInput({ persona: '他是个怕水的人。', traits: { caution: 999 }, competence: { intrigue: 9 } }, card);
  ok(edited.persona === '他是个怕水的人。' && edited.traits.caution === 100 && edited.competence.intrigue === 2, '玩家改卡:文案生效、数值夹回区间', edited);

  /* ---------- 记忆库 ---------- */
  const book = memoryBook(me.id);
  for (let i = 0; i < MEMORY_MAX + 6; i++) addMemory(book, { year: 1200 + i, kind: 'war', text: `第 ${i} 件事`, weight: i % 2 ? 0.9 : 0.2, source: 'engine' });
  ok(book.entries.length === MEMORY_MAX, `记忆上限 ${MEMORY_MAX} 条`, book.entries.length);
  ok(book.entries.every((e) => e.weight >= 0.2), '淘汰先丢权重低的');
  const writes = cleanMemoryWrites([{ text: 'x'.repeat(200) }, { text: '第二条' }, { text: '第三条' }], 1210);
  ok(writes.length === 2 && writes[0]!.text.length <= 60, '君主自述每回合最多 2 条、每条 ≤60 字', writes);
  const dup = memoryBook(1);
  addMemory(dup, { year: 1200, kind: 'war', text: '同一件事', weight: 0.5, source: 'engine' });
  addMemory(dup, { year: 1200, kind: 'war', text: '同一件事', weight: 0.5, source: 'engine' });
  ok(dup.entries.length === 1, '同年同文不重复记', dup.entries.length);

  /* ---------- 逐州属性表 ---------- */
  const table = regionTable(s.civ, me.id, 1200);
  ok(table.total.count > 0 && table.total.pop >= 0, '逐州表有州、有人口', table.total);
  ok(table.rows.length <= 10, '逐州表按 top-N 截断', table.rows.length);
  ok(table.note.includes('推算') && table.rows.every((r) => r.taxDerived && r.stabilityDerived), '税收/稳定度标明"推算"');
  ok(table.total.stability === null || (table.total.stability >= 0 && table.total.stability <= 100), '稳定度在 0–100', table.total.stability);

  /* ---------- 提示词分层 ---------- */
  const brief = buildMonarchBriefs(s.civ, s.play, [me.id])[0]! as MonarchBrief;
  const msgs = monarchMessages({ brief, card, memory: book, regions: table, intel: [foreignIntel(s.civ, other.id, 1200)] });
  const sys = msgs[0]!.content;
  const user = msgs[1]!.content;
  ok(sys.includes('## 你是谁(角色卡)') && sys.includes('## 输出格式'), 'system = 身份 + 角色卡 + 命令契约');
  ok(!sys.includes('第 1200 年'), 'system 不含年份(前缀缓存可命中)');
  ok(user.includes('第 1200 年'), 'user 含年份(易变段后置)');
  ok(user.includes('你的领土') && user.includes('他国情报'), 'user 含逐州表与情报段');
  const msgs2 = monarchMessages({ brief, card, memory: book, regions: table });
  ok(msgs2[0]!.content === sys, '同一君主跨回合 system 逐字节一致');

  /* ---------- 高影响命令审核(规则路径) ---------- */
  const cautious = { ...card, traits: { ...card.traits, caution: 85 }, preferences: { ...card.preferences, war: 'avoid' as const } };
  const declare = [cleanIntervention({ kind: 'declare', from: 1200, a: me.key, b: other.key })!];
  const briefWithNeighbor = { ...brief, neighbors: [{ id: other.id, name: other.name, size: other.size }] };
  const verdict = auditByRule({ polityId: me.id, brief: briefWithNeighbor, card: cautious, commands: declare }, 0);
  ok(verdict.outcome === 'soften' && verdict.source === 'rule', '谨慎且避战的君主宣战 → 规则审核降级', verdict);
  const aggressive = { ...card, traits: { ...card.traits, caution: 10 }, preferences: { ...card.preferences, war: 'seek' as const } };
  const v2 = auditByRule({ polityId: me.id, brief: briefWithNeighbor, card: aggressive, commands: declare }, 0);
  ok(v2.outcome === 'allow', '好战君主宣战 → 放行', v2);

  /* ---------- intel 进命令史 ---------- */
  const rawIntel = { kind: 'intel', a: me.key, b: other.key, from: 1200, focus: 'all' };
  const cleaned = cleanIntervention(rawIntel) as { kind: string; result?: string } | null;
  ok(!!cleaned && cleaned.kind === 'intel', 'intel 是引擎认的干预(第 27 种)', cleaned);
  ok(cleanIntervention({ ...rawIntel, b: me.key }) === null, 'intel 不能指向自己');
  const order = cleanOrders(s.play, [rawIntel]);
  ok(order.commands.length === 1 && order.rejected.length === 0, 'cleanOrders 收下 intel', order);

  const s2 = getSession(openSession({ worldId: world.id, startYear: 1200, stepYears: 5, maxRounds: 3, mode: 'monarch' }).summary.sessionId);
  const intelCmd = cleanIntervention({ ...rawIntel })!;
  const resolved = await resolveIntel(s2, [intelCmd], null);
  const withResult = resolved.commands[0] as { kind: string; result?: string };
  ok(!!withResult.result, '没有 Jev 时也按确定性规则判定出 result', withResult);
  ok(s2.intel && s2.intel[String(me.id)] && s2.intel[String(me.id)]![String(other.id)], '情报状态写进会话', s2.intel);
  const known = s2.intel![String(me.id)]![String(other.id)]!;
  ok(known.fields.every((f) => ['pop', 'stability', 'tax'].includes(f)), '拿到的字段在 pop/stability/tax 里', known.fields);
  submitOrders(s2, resolved.commands);
  turnStep(s2, { years: 5 });
  const replay = verifySession(s2);
  ok(replay.ok, '含 intel 命令的会话回放一致(引擎不受影响)', replay);

  /* ---------- plan / commit 与复核否决 ---------- */
  setupMonarch(s, { polities: 'all', mock: true });
  const plan = await monarchPlan(s);
  ok(s.play.year === 1200 && s.rounds === 0, '出方案不推演(年份/回合没动)', { year: s.play.year, rounds: s.rounds });
  ok(plan.decisions.length >= 2 && plan.commands.length >= 0, '方案含每位君主的决策', plan.decisions.length);
  ok(plan.audit.source === 'rule', '没有 Jev 时审核走规则', plan.audit);
  ok(s.cards && s.cards.size >= 2, '出方案时生成了角色卡', s.cards?.size);
  const firstRef = plan.commandRefs[0];
  const after = await monarchCommit(s, firstRef ? { reject: [firstRef] } : {});
  ok(after.round === 1 && s.play.year === 1205, '提交后推进一步(1200 → 1205)', { round: after.round, year: s.play.year });
  ok(verifySession(s).ok, '复核否决后回放仍一致', verifySession(s));

  const round2 = await monarchRound(s);
  ok(round2.round === 2 && s.play.year === 1210, '完整回合接口仍可直接用', { round: round2.round, year: s.play.year });
  const st = stateGet(s);
  ok(Array.isArray(st.cards) && st.cards.length >= 2 && Array.isArray(st.memory), '状态里带 cards / memory', { cards: (st.cards as unknown[])?.length });
  ok(s.memory && [...s.memory.values()].some((b) => b.entries.length > 0), '回合结束后记忆库有内容');

  /* ---------- 双开关 ---------- */
  const s3 = getSession(openSession({ worldId: world.id, startYear: 1200, stepYears: 5, maxRounds: 2, mode: 'monarch', features: { llm: false, jev: true } }).summary.sessionId);
  let llmErr = '';
  try {
    await monarchPlan(s3);
  } catch (e) {
    llmErr = e instanceof Error ? e.message : String(e);
  }
  ok(llmErr.includes('LLM 扮演'), 'LLM 关着 → 明确报"没打开 LLM 扮演"', llmErr);
  await pettySetup(s3, { mock: true });
  const pr = await pettyRound(s3, { years: 5 });
  ok(s3.play.year === 1205 && pr.round === 1, '仅 Jev(mock)也能推回合', { year: s3.play.year, round: pr.round });
  ok(s3.features.jev === true, '配置小事件后 Jev 开关为开', s3.features);

  const s4 = getSession(openSession({ worldId: world.id, startYear: 1200, stepYears: 5, maxRounds: 2, mode: 'monarch', features: { llm: false, jev: false } }).summary.sessionId);
  const plain = turnStep(s4, { years: 5 });
  ok(plain.round === 1 && s4.play.year === 1205, '双关 = 纯引擎推演', { round: plain.round, year: s4.play.year });

  /* ---------- 改卡 ---------- */
  const before = s.cards!.get(me.id)!;
  const card2 = setMonarchCard(s, me.id, { persona: '他现在只想守住祖业。' }) as { persona: string };
  ok(card2.persona === '他现在只想守住祖业。' && s.cards!.get(me.id)!.persona !== before.persona, '玩家/DM 改角色卡只改文案/档位');

  const status = monarchStatus(s) as Record<string, unknown>;
  ok(status.features && (status.features as { llm: boolean }).llm === true, '君主状态里带双开关', status.features);

  console.log(`\n通过 ${pass} 项,失败 ${fail} 项,用时 ${Date.now() - started} ms`);
  if (fail) process.exitCode = 1;
}

void main();
