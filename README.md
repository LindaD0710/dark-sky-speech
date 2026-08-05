# 暗夜表达

看看你说的话，别人听进去了多少。依据金字塔原理与麦肯锡电梯法则。

**在线体验：** https://speech.chuxiuxiaoji.com
**项目运行说明：** [项目运行说明文档.md](项目运行说明文档.md)

## 目录

```
public/index.html  前端（单文件，无框架）
api/prompt.js      分析 prompt —— 单一真源，线上和测试共用这一份
api/llm.js         DeepSeek 调用 + 结构校验 + 自动重试 + 输出收敛
api/analyze.js     Vercel Serverless Function，POST /api/analyze
test/gold.json     两条语料 + 人工标准答案
test/run.mjs       跑模型、对比、打分
```

`../暗夜表达_原型_v1.html` 是没接引擎的纯前端原型，留着做参照，不参与部署。

## 降级设计

前端永远不会给用户看报错页。引擎不通时：

| 路径 | 降级后 |
|---|---|
| 预置场景 | 用打包好的结构和重写，体验完整 |
| 自定义文本 | 逐行标注走本地规则；金字塔和重写会明说"需要接入引擎" |

## 先跑这一测（最重要）

```bash
cd 暗夜表达
DEEPSEEK_API_KEY=sk-你的key node test/run.mjs
```

它会问模型五件事，其中**两件是决定成败的**：

1. 能不能推断出说话人**从没说出口的结论**（"我应该涨薪"）
2. 能不能推断出**从没说出口的两条理由**

这两条过了，金字塔这条路就通；过不了，金字塔要降级成"只标注不推断"。

脚本退出码 0 = 通过，1 = 未过。

想试推理模型：

```bash
DEEPSEEK_API_KEY=sk-xxx LLM_MODEL=deepseek-reasoner node test/run.mjs
```

想试 Kimi（接口兼容，只换两个环境变量）：

```bash
DEEPSEEK_API_KEY=你的moonshot key \
LLM_BASE_URL=https://api.moonshot.cn/v1 \
LLM_MODEL=moonshot-v1-32k \
node test/run.mjs
```

## 部署

沿用你现有的路径：**本地 → GitHub → Vercel → Cloudflare 域名**。

```bash
cd 暗夜表达
git init && git add -A && git commit -m "暗夜表达 · 首版"
# 在 GitHub 建一个空仓库，然后：
git remote add origin git@github.com:你的账号/仓库名.git
git push -u origin main
```

1. Vercel 导入这个仓库，框架选 **Other**，其余全默认
2. 项目设置 → Environment Variables → 加 `DEEPSEEK_API_KEY`（**这是唯一放 key 的地方**）
3. 部署。`public/index.html` 自动成为首页，`api/analyze.js` 自动成为 `/api/analyze`
4. Cloudflare 把域名 CNAME 指到新的 Vercel 项目

部署完先自测：打开链接 → 选场景 → 粘一段自己的话 → 看金字塔是不是真的按你的话搭出来的。
如果金字塔那块显示"需要接入引擎"，说明环境变量没生效，回第 2 步。

**key 只存在于第 3 步的环境变量里，永远不进浏览器。**

## 费用与限流

作品是公开链接，用的是你自己的 key，账单也是你的。`analyze.js` 里已经做了：

- 单 IP 每分钟 4 次、每天 40 次
- 输入硬顶 1500 字（3 分钟的话约 800 字）
- 出错一律返回 `degraded: true`，前端退回本地规则，不给用户看报错页

**限流是尽力而为的**：Vercel 每个实例内存独立，重启清零，挡得住误点和轻度滥用，挡不住有心人。如果笔记真跑起来了，换成 Vercel KV 计数。

## 契约

```
POST /api/analyze
{ "scenarioId": "intro" | "claim",
  "sentences": [{ "text": "…" }] }

200
{ "roles":   ["FILLER", "BACKGROUND", …],
  "pyramid": { "conclusion": {"text":"…","said":null},
               "reasons":[{"text":"…","said":null,
                           "evidence":[{"text":"…","said":5,"misframed":"当成表功说了"}]}] },
  "better":  "第一段。\n\n第二段。" }

200 + degraded:true   出了任何问题都走这里，前端负责降级
429                   触发限流
413                   超过 1500 字
```

`said` 是原文句号，`null` 表示这句话说话人从没说过、是模型推断出来的。
