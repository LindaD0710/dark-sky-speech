/**
 * 拿两条语料去问模型，跟人工标准答案比对。
 *
 *   DEEPSEEK_API_KEY=sk-xxx node test/run.mjs
 *   DEEPSEEK_API_KEY=sk-xxx LLM_MODEL=deepseek-reasoner node test/run.mjs
 *
 * 最关键的一问：模型能不能自己推断出说话人从没说出口的结论和理由。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SYSTEM, buildUserPrompt } from '../api/prompt.js';
import { analyzeWithRetry } from '../api/llm.js';

const here = dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(readFileSync(join(here, 'gold.json'), 'utf8'));

const C = { g:'\x1b[32m', r:'\x1b[31m', y:'\x1b[33m', d:'\x1b[2m', x:'\x1b[0m', b:'\x1b[1m' };
const mark = ok => ok ? `${C.g}通过${C.x}` : `${C.r}未过${C.x}`;

/** better 里出现的数字，必须在原话里出现过 —— 这是"不许编事实"的自动闸门 */
function inventedNumbers(better, sourceText) {
  const src = sourceText.replace(/\s/g, '');
  return [...new Set(better.match(/\d+(?:\.\d+)?/g) || [])]
    .filter(n => !src.includes(n));
}

async function runCase(cs) {
  const sentences = cs.sentences.map(text => ({ text }));
  const source = cs.sentences.join('');
  const t0 = Date.now();

  const out = await analyzeWithRetry({
    system: SYSTEM,
    user: buildUserPrompt({ scenarioId: cs.scenarioId, sentences }),
    sentences
  });
  const { usage, model } = out;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const g = cs.gold;

  // 1. 角色分类准确率
  const hit = out.roles.filter((r, i) => r === g.roles[i]).length;
  const roleAcc = hit / g.roles.length;

  // 2. 结论分两件事看：给没给出结论（阻塞项）／有没有指对出处（不阻塞）
  const cSaid = out.pyramid.conclusion.said;
  const conclusionOK  = out.pyramid.conclusion.text.length >= 6
                     && !out.pyramid.conclusion.text.includes('模型没有给出');
  // 金字塔原理里诉求可以充当结论，所以指向 ASK 那句同样算对
  const askIdx = g.roles.map((r,i)=> r === 'ASK' ? i : -1).filter(i => i >= 0);
  const acceptable = new Set([g.conclusionSaid, ...askIdx]);
  const attributionOK = acceptable.has(cSaid);

  // 3. 理由层：数量够不够，该推断的有没有推断出来
  const reasons = out.pyramid.reasons;
  const inferred = reasons.filter(r => r.said === null).length;
  const reasonsOK = reasons.length >= g.reasonCount && inferred >= g.reasonsInferred;

  // 4. 证据归属：金句有没有被挂到某条理由下面
  const gotIdx = new Set(reasons.flatMap(r => r.evidence.map(e => e.said)).filter(i => i !== null));
  const foundEv = g.evidenceIndices.filter(i => gotIdx.has(i));
  const evidenceOK = foundEv.length >= Math.ceil(g.evidenceIndices.length * 0.6);
  const everyReasonHasEv = reasons.every(r => r.evidence.length > 0);

  // 5. 改好的版本
  const invented = inventedNumbers(out.better, source);
  const missing  = g.mustAppearInBetter.filter(k => !out.better.replace(/\s/g,'').includes(k.replace(/\s/g,'')));
  const paras    = out.better.split(/\n\n+/).filter(Boolean).length;

  // 诉求被自己收回去 —— 「向上争取」最典型的失败，必须挡住
  const RETRACT = /(改天再说|下次再说|实在不方便|要是不合适|就算了|当我没说|不着急|随您|您看着办)/;
  const retracted = RETRACT.test(out.better);
  // 被判成废话的句子又被捡回来
  // 整句扫窗，不只比前几个字 —— 模型常常只搬后半截（"什么活都能接"）
  const flat = s => s.replace(/[，。、！？…：；\s]/g, '');
  const betterFlat = flat(out.better);
  const at = t => {                      // 这句废话在改好的版本里出现在第几个字，没出现返回 -1
    const c = flat(t);
    for (let i = 0; i + 6 <= c.length; i++) {
      const k = betterFlat.indexOf(c.slice(i, i + 6));
      if (k >= 0) return k;
    }
    return -1;
  };
  // 诉求落在哪 —— 诉求之后的"承认对方处境"是协商手艺，不算捡废话
  const askText = g.roles.map((r,i)=> r==='ASK' ? cs.sentences[i] : null).filter(Boolean)[0];
  const askAt = askText ? at(askText) : -1;
  const ACK = /(不容易|理解|知道.*难|流程|有难度|不好办)/;   // 承认对方处境
  const POLITE = /(方便吗|占用您|耽误您|打扰|几分钟|有空吗)/;   // 开场征得同意，是协商的第一步
  const recycled = g.roles
    .map((r, i) => (r === 'PLATITUDE' || r === 'FILLER') ? cs.sentences[i] : null)
    .filter(Boolean)
    .filter((t, k) => {
      const i = g.roles.findIndex((r, j) => (r === 'PLATITUDE' || r === 'FILLER') && cs.sentences[j] === t);
      const pos = at(t);
      if (pos < 0) return false;
      // 模型自己把这句判成了信号 —— 那它就不是在捡废话，是我们的标注有分歧
      if (['CLAIM','ASK','EVIDENCE'].includes(out.roles[i])) return false;
      if (askAt >= 0 && pos > askAt && ACK.test(t)) return false;  // 诉求之后的台阶，放行
      if (POLITE.test(t) && pos < 30) return false;                // 开头的征询，放行
      return true;
    });

  // 元话语：把金字塔的结构念出来了 —— 说明它在背模板，不是在说话
  const META = /(我直接说结论|先说结论|我的结论是|结论先行|为什么这么说|总结一下|首先.*其次.*最后|第一点.*第二点)/;
  const meta = META.test(out.better);
  // 「向上争取」的收尾必须请教差距，而不只是约时间
  const needsGap = cs.scenarioId === 'claim';
  const GAP = /(差距|还差|不够|标准|需要我|怎么做|哪些方面|达到)/;
  const gapAsk = GAP.test(out.better.slice(-120));
  // 面试里请教差距 = 讨 offer，是「向上争取」的收尾串味过来了
  const bledOver = !needsGap && (GAP.test(out.better.slice(-140)) || /不是今天能定|今天就定/.test(out.better));
  // 面试里把决定权说成在自己手上 —— 居高临下，即使原话就这么说也要改掉
  const CONDESCEND = /(我们可以聊|我可以来|我可以考虑一下你们|可以给你们一个机会|我们聊聊看)/;
  const condescending = !needsGap && CONDESCEND.test(out.better);

  // 结论先行 —— 产品的立身之本。
  // 用关键词判，不做字面全匹配：模型换个措辞表达同一个结论，不该算它错。
  const firstPara = flat(out.better.split(/\n\n+/)[0] || '');
  const head = flat(out.better).slice(0, 60);
  const kws = g.conclusionKeywords || [];
  let conclusionFirst = kws.length
    ? kws.some(k => firstPara.includes(flat(k)))
    : false;
  if (!conclusionFirst) {           // 没给关键词就退回字面匹配
    const cFlat = flat(out.pyramid.conclusion.text);
    for (let i = 0; i + 6 <= cFlat.length; i++) {
      if (head.includes(cFlat.slice(i, i + 6))) { conclusionFirst = true; break; }
    }
  }

  // 诉求要有 What/When —— 「想请您考虑一下」这种对方可以永远考虑下去
  const VAGUE = /(考虑一下|再想想|有空(的时候)?聊|看看吧|再说吧|方便的时候)/;
  const CONCRETE = /(这周|下周|本周|周[一二三四五]|明天|几分钟|半小时|定个时间|安排.*时间|定个|过一下)/;
  // 向上争取：诉求必须落到具体动作或时间上，不能只有一个「希望您考虑」
  const vagueAsk = needsGap && (VAGUE.test(out.better) || !CONCRETE.test(out.better));

  const betterOK = invented.length === 0 && missing.length === 0 && conclusionFirst && !vagueAsk
                && !retracted && !recycled.length && !meta && !bledOver && !condescending
                && (!needsGap || gapAsk)
                && out.better.length >= g.betterMinChars && paras >= 2;

  console.log(`\n${C.b}━━━ ${cs.name} ━━━${C.x}  ${C.d}${model} · ${secs}s · ${usage?.total_tokens ?? '?'} tok · 第 ${out.attempts} 次${out.warning?' · '+out.warning:''}${C.x}`);
  console.log(`  角色分类      ${mark(roleAcc >= 0.75)}  ${(roleAcc*100).toFixed(0)}%  (${hit}/${g.roles.length})`);
  out.roles.forEach((r, i) => {
    if (r === g.roles[i]) return;
    console.log(`      ${C.y}第 ${String(i).padStart(2)} 句${C.x}  标准 ${C.g}${g.roles[i].padEnd(10)}${C.x} 模型 ${C.r}${r.padEnd(10)}${C.x} ${C.d}${cs.sentences[i]}${C.x}`);
  });
  console.log(`  给出结论      ${mark(conclusionOK)}  「${out.pyramid.conclusion.text}」`);
  console.log(`  指对出处      ${mark(attributionOK)}  ${C.d}模型说${cSaid===null?'是自己推断的':'来自第 '+cSaid+' 句'}，标准答案是${g.conclusionSaid===null?'没说过':'第 '+g.conclusionSaid+' 句'}${C.x}`);
  console.log(`  推断出理由    ${mark(reasonsOK)}  ${reasons.length} 条，其中 ${inferred} 条是推断的`);
  reasons.forEach((r,i)=> console.log(`      ${C.d}${i+1}.${C.x} ${r.text} ${C.d}(${r.evidence.length} 条证据)${C.x}`));
  console.log(`  证据归了位    ${mark(evidenceOK && everyReasonHasEv)}  命中 ${foundEv.length}/${g.evidenceIndices.length}${everyReasonHasEv?'':C.r+'  有理由是空的'+C.x}`);
  const tooShort = out.better.length < g.betterMinChars;
  console.log(`  改好的版本    ${mark(betterOK)}  ${out.better.length} 字，${paras} 段${tooShort?C.r+`  太短了（下限 ${g.betterMinChars}）`+C.x:''}`);
  if (vagueAsk)         console.log(`      ${C.r}诉求没落到具体动作或时间上 —— 对方可以无限期「考虑」下去${C.x}`);
  if (!conclusionFirst) console.log(`      ${C.r}结论没在开头 —— 前 45 个字里找不到它，这正是原话的病${C.x}`);
  if (invented.length) console.log(`      ${C.r}编造了原话里没有的数字：${invented.join('、')}${C.x}`);
  if (missing.length)  console.log(`      ${C.y}丢了关键内容：${missing.join('、')}${C.x}`);
  if (retracted)       console.log(`      ${C.r}诉求被自己收回去了${C.x}`);
  if (recycled.length) console.log(`      ${C.r}把废话捡回来了：${recycled.map(t=>t.slice(0,12)).join(' / ')}${C.x}`);
  if (meta)            console.log(`      ${C.r}出现了元话语（"我直接说结论""为什么这么说"这类），金字塔的痕迹露出来了${C.x}`);
  if (needsGap && !gapAsk) console.log(`      ${C.r}收尾只约了时间，没有主动请教差距${C.x}`);
  if (condescending)       console.log(`      ${C.r}「我们可以聊」这类说法：把决定权说成在自己手上，对面试官显得居高临下${C.x}`);
  if (bledOver)            console.log(`      ${C.r}面试里用了「向上争取」的收尾（请教差距／不是今天能定），像在讨 offer${C.x}`);
  console.log(`${C.d}      ${out.better.replace(/\n\n/g, '\n      ')}${C.x}`);

  const passes = [roleAcc >= 0.75, conclusionOK, attributionOK, reasonsOK, evidenceOK && everyReasonHasEv, betterOK];
  return { name: cs.name, passed: passes.filter(Boolean).length, total: passes.length, blocking: conclusionOK && reasonsOK };
}

const results = [];
for (const cs of cases) {
  try { results.push(await runCase(cs)); }
  catch (e) { console.log(`\n${C.r}${cs.name} 跑挂了：${e.message}${C.x}`); results.push({ name: cs.name, passed: 0, total: 6, blocking: false }); }
}

console.log(`\n${C.b}━━━ 汇总 ━━━${C.x}`);
results.forEach(r => console.log(`  ${r.name}  ${r.passed}/${r.total}`));
const goNoGo = results.every(r => r.blocking);
console.log(`\n${C.b}关键一问：模型能不能自己推断出没说出口的结论和理由？${C.x}`);
console.log(goNoGo
  ? `  ${C.g}能。金字塔这条路走得通，可以接着做。${C.x}`
  : `  ${C.r}不能。金字塔要降级成"只标注不推断"，或者换模型/改 prompt 再试。${C.x}`);
process.exit(goNoGo ? 0 : 1);
