/**
 * DeepSeek 调用层。
 * 接口是 OpenAI 兼容的，所以之后想换 Kimi（Moonshot）只要改 BASE_URL 和 MODEL。
 */

const BASE_URL = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
const MODEL    = process.env.LLM_MODEL    || 'deepseek-chat';

export async function callLLM({ system, user, apiKey, model = MODEL, timeoutMs = 60000 }) {
  const key = apiKey || process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('缺少 API key：请设置环境变量 DEEPSEEK_API_KEY');

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user }
    ],
    temperature: 0.3,
    max_tokens: 4000
  };
  // 推理模型不接受 temperature / response_format，普通模型才开 JSON 模式
  if (model.includes('reasoner')) {
    delete body.temperature;
  } else {
    body.response_format = { type: 'json_object' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return { text, usage: data?.usage || null, model };
}

/** 模型偶尔会裹 ```json 或在前后加话，这里做一次宽容解析 */
export function parseJSON(text) {
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch {}
  }
  throw new Error('模型没有返回可解析的 JSON');
}

/**
 * 结构上明显不合格的输出，值得重来一次。
 * 同一份 prompt 两次跑出来的结果本来就有波动 —— 与其继续调 prompt，不如兜住波动。
 */
export function looksBroken(out) {
  if (!out) return '没有输出';
  if (out.applicable === false) return null;   // 本来就不该套金字塔，别重跑
  const p = out.pyramid;
  if (!p?.conclusion?.text) return '没有结论';
  if (!Array.isArray(p.reasons) || p.reasons.length < 2) return '理由少于 2 条';
  if (p.reasons.some(r => !r.evidence?.length)) return '有理由下面是空的';
  if (/[，。]?(且|并且|同时)/.test(p.reasons.map(r => r.text).join(''))) return '有理由把两件事压成了一条';
  if (!out.better || out.better.length < 100) return '改好的版本太短';
  return null;
}

/** 分析一次；结构不合格就重来一次，两次都不行就用较好的那次 */
export async function analyzeWithRetry({ system, user, sentences, model }) {
  let best = null, bestWhy = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, usage, model: used } = await callLLM({ system, user, model });
    const out = normalize(parseJSON(text), sentences);
    const why = looksBroken(out);
    if (!why) return { ...out, model: used, usage, attempts: attempt + 1 };
    if (!best) { best = { ...out, model: used, usage }; bestWhy = why; }
  }
  return { ...best, attempts: 2, warning: bestWhy };
}

/**
 * 把模型输出收敛成前端能直接用的形状。
 * 模型可能漏字段、可能给出越界的句号，这里全部兜住 —— 宁可降级，不可崩。
 */
export function normalize(raw, sentences) {
  const n = sentences.length;
  const ok = i => (Number.isInteger(i) && i >= 0 && i < n) ? i : null;
  const ROLE = new Set(['CLAIM','ASK','EVIDENCE','SETUP','BACKGROUND','PROCESS','PLATITUDE','FILLER']);

  const roles = new Array(n).fill('BACKGROUND');
  (raw?.segments || []).forEach(s => {
    const i = ok(s?.i);
    if (i !== null && ROLE.has(s?.role)) roles[i] = s.role;
  });

  const p = raw?.pyramid || {};
  const node = x => x && typeof x.text === 'string' && x.text.trim()
    ? { text: x.text.trim(), said: ok(x.said),
        ...(x.misframed ? { misframed: String(x.misframed) } : {}),
        ...(Array.isArray(x.setup) ? { setup: x.setup.map(ok).filter(i => i !== null) } : {}) }
    : null;

  const pyramid = {
    conclusion: node(p.conclusion) || { text: '（模型没有给出结论）', said: null },
    reasons: (Array.isArray(p.reasons) ? p.reasons : [])
      .map(r => {
        const base = node(r);
        if (!base) return null;
        base.evidence = (Array.isArray(r.evidence) ? r.evidence : []).map(node).filter(Boolean);
        return base;
      })
      .filter(Boolean)
      .slice(0, 4)
  };

  const better = typeof raw?.better === 'string' ? raw.better.trim() : '';

  // 对方视角：说反应不说评价。越界的（出现"你没有""你应该"）直接丢掉
  const listener = (Array.isArray(raw?.listener) ? raw.listener : [])
    .map(l => (l && typeof l.text === 'string' && l.text.trim())
      ? { at: ok(l.at), text: l.text.trim() } : null)
    .filter(l => l && !/^你(没有|应该|需要|不该)/.test(l.text))
    .slice(0, 4);

  const applicable = raw?.applicable !== false;

  return {
    roles, pyramid, better, listener, applicable,
    notApplicable: applicable ? null : (typeof raw?.notApplicable === 'string' ? raw.notApplicable : '这段话不适合用金字塔来量')
  };
}
