/**
 * POST /api/analyze
 *
 * 入参 { scenarioId: 'intro'|'claim', sentences: [{text}] }
 * 出参 { roles: [...], pyramid: {...}, better: '...' }
 *
 * API key 只存在于 Vercel 环境变量，永远不进浏览器。
 */
import { SYSTEM, buildUserPrompt } from './prompt.js';
import { analyzeWithRetry } from './llm.js';

const MAX_CHARS     = 1500;  // 3 分钟的话约 800 字，1500 是硬顶
const MAX_SENTENCES = 80;
const PER_IP_PER_MIN = 4;
const PER_IP_PER_DAY = 40;

/* 尽力而为的限流。Vercel 每个实例内存独立，重启就清零 —— 挡得住误点和轻度滥用，
   挡不住有心人。真要扛量得换 Vercel KV，见 README。 */
const hits = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { min: [], day: [] };
  rec.min = rec.min.filter(t => now - t < 60_000);
  rec.day = rec.day.filter(t => now - t < 86_400_000);
  if (rec.min.length >= PER_IP_PER_MIN) return '慢一点，一分钟最多分析 4 次';
  if (rec.day.length >= PER_IP_PER_DAY) return '今天的额度用完了，明天再来';
  rec.min.push(now); rec.day.push(now);
  hits.set(ip, rec);
  if (hits.size > 5000) hits.clear();
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '只接受 POST' });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const limited = rateLimit(ip);
  if (limited) return res.status(429).json({ error: limited, degraded: true });

  try {
    const { scenarioId, sentences } = req.body || {};
    if (!Array.isArray(sentences) || !sentences.length) {
      return res.status(400).json({ error: '没有收到句子' });
    }
    const clean = sentences
      .map(s => ({ text: String(s?.text ?? '').trim() }))
      .filter(s => s.text.length > 1)
      .slice(0, MAX_SENTENCES);

    const total = clean.reduce((a, s) => a + s.text.length, 0);
    if (!clean.length)        return res.status(400).json({ error: '没有可分析的内容' });
    if (total > MAX_CHARS)    return res.status(413).json({ error: `太长了，最多 ${MAX_CHARS} 字，你有 ${total} 字` });

    const user = buildUserPrompt({ scenarioId, sentences: clean });
    const out = await analyzeWithRetry({ system: SYSTEM, user, sentences: clean });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(out);
  } catch (err) {
    // 前端拿到 degraded 就退回本地规则 + 预置样本，不给用户看报错页
    return res.status(200).json({
      degraded: true,
      error: String(err?.message || err).slice(0, 200)
    });
  }
}
