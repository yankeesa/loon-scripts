/**
 * dsl-worker.js — DualSubs LLM 字幕网关（Cloudflare Worker 版）
 *
 * 与 Python 版（dsl-gateway.py）逻辑等价：假冒 Google 翻译接口，
 * 把 DualSubs 发来的整段字幕交给 LLM 翻译，带术语表、带上下文、带缓存。
 *
 * 部署：Cloudflare Dashboard → Workers & Pages → Create Worker → 粘贴本文件
 * 环境变量（Settings → Variables）：
 *   LLM_BASE   https://你的中转站/v1        （必填）
 *   LLM_KEY    sk-xxxx                      （必填）
 *   LLM_MODEL  gpt-4o-mini                  （可选）
 *   AUTH_TOKEN 自定义一串随机字符            （强烈建议，防别人白嫖你的额度）
 *   GLOSSARY_BASE 术语表目录（可选，默认指向 GitHub）
 *
 * 自检：浏览器打开 https://<你的域名>/  应返回 {"ok":true,...}
 */

const CHUNK = 30;             // 每批句数
const MAX_CONC = 4;           // 并发批数
const LLM_TIMEOUT = 20000;    // 单批 LLM 超时(ms)
const CACHE_TTL = 60 * 60 * 24 * 30;
const GLOSSARY_TTL = 60 * 60 * 6;

const GLOSSARY_BASE_DEFAULT =
  "https://raw.githubusercontent.com/yankeesa/loon-scripts/master/glossary";

const DOMAIN_TRIGGERS = {
  f1: ["drs", "verstappen", "norris", "leclerc", "piastri", "hamilton", "russell",
       "grand prix", "qualifying", "pit stop", "undercut", "safety car", "lap ",
       "f1", "formula 1", "tyre", "pole"],
  mls: ["offside", "corner kick", "midfield", "penalty", "mls", "soccer", "goal",
        "keeper", "striker", "playoff", "leagues cup"],
  fitness: ["squat", "lunge", "burpee", "plank", "rep", "set", "workout", "coach",
            "hiit", "core", "dumbbell", "kettlebell", "stretch", "mat"],
};

const SYSTEM_PROMPT = `你是专业的影视与体育字幕译者。用户会给你带编号的英文台词（来自英文隐藏式字幕 CC），你要逐条翻译成简体中文。

硬性规则：
1. 每条以 [编号] 开头。你必须为每一个编号都返回译文，编号一一对应，绝不合并、拆分、跳过或自行新增。
2. 只输出一个 JSON 对象：key 为编号字符串，value 为译文。不要输出任何解释、不要用代码块包裹。
3. 保留说话人标记 ">>"、音乐符号 "♪"、方括号音效（如 [engine revving]），只翻译其中的文字内容。
4. 数字、单位、缩写按术语表处理；术语表未收录的专有名词，自行统一译名并全篇一致。
5. 中文要口语自然、符合解说或对白语气，避免书面腔，不要添加引号或句末多余标点。

【术语表 · 必须严格遵守】
{glossary}
`;

// ---------------------------------------------------------------- 术语表
let GL_CACHE = { t: 0, data: null };

async function loadGlossary(env) {
  const now = Date.now();
  if (GL_CACHE.data && now - GL_CACHE.t < GLOSSARY_TTL * 1000) return GL_CACHE.data;
  const base = (env.GLOSSARY_BASE || GLOSSARY_BASE_DEFAULT).replace(/\/+$/, "");
  const out = {};
  await Promise.all(
    ["f1", "mls", "fitness", "general"].map(async (dom) => {
      try {
        const r = await fetch(`${base}/${dom}.json`, { cf: { cacheTtl: GLOSSARY_TTL } });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        const o = {};
        for (const k of Object.keys(j)) if (!k.startsWith("_")) o[k] = j[k];
        out[dom] = o;
      } catch (e) {
        out[dom] = {};
      }
    })
  );
  GL_CACHE = { t: now, data: out };
  return out;
}

function pickDomains(texts) {
  const blob = texts.join("\n").toLowerCase();
  const score = {};
  for (const dom of Object.keys(DOMAIN_TRIGGERS)) {
    score[dom] = DOMAIN_TRIGGERS[dom].reduce((n, k) => n + blob.split(k).length - 1, 0);
  }
  let best = null;
  for (const d of Object.keys(score)) if (best === null || score[d] > score[best]) best = d;
  const picked = ["general"];
  if (best && score[best] > 0) picked.unshift(best);
  return picked;
}

function glossaryBlock(gl, domains) {
  const lines = [];
  for (const d of domains) {
    const m = gl[d] || {};
    for (const k of Object.keys(m)) lines.push(`${k} => ${m[k]}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- LLM
async function llmChat(env, messages) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT);
  try {
    const res = await fetch(`${(env.LLM_BASE || "").replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + (env.LLM_KEY || ""),
      },
      body: JSON.stringify({
        model: env.LLM_MODEL || "gpt-4o-mini",
        messages,
        temperature: 0.2,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("LLM HTTP " + res.status + " " + (await res.text()).slice(0, 200));
    const body = await res.json();
    return body?.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timer);
  }
}

function parseMapping(raw, n) {
  let text = (raw || "").trim().replace(/^```(?:json)?/gm, "").replace(/```$/gm, "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (m) text = m[0];
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    obj = {};
    for (const line of text.split("\n")) {
      const mm = line.match(/^\s*\[?(\d+)\]?\s*[:：.]?\s*(.+)$/);
      if (mm) obj[mm[1]] = mm[2].trim();
    }
  }
  const out = [];
  for (let i = 1; i <= n; i++) {
    let v = obj && (obj[String(i)] !== undefined ? obj[String(i)] : obj[i]);
    if (v === undefined || v === null || v === "") v = null;
    out.push(v === null ? null : String(v).trim());
  }
  return out;
}

async function translateChunk(env, gl, texts) {
  const body = texts.map((t, i) => `[${i + 1}] ${t}`).join("\n");
  const domains = pickDomains(texts);
  const raw = await llmChat(env, [
    { role: "system", content: SYSTEM_PROMPT.replace("{glossary}", glossaryBlock(gl, domains)) },
    { role: "user", content: `请翻译以下 ${texts.length} 条字幕：\n\n${body}` },
  ]);
  const res = parseMapping(raw, texts.length);
  console.log(`batch ${texts.length} · dom=${domains.join("+")} · missing=${res.filter((x) => !x).length}`);
  return res;
}

// ---------------------------------------------------------------- 缓存
async function sha1(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cacheUrl(sl, tl, text) {
  return "https://dsl-cache.internal/v1/" + encodeURIComponent(sl) + "/" +
         encodeURIComponent(tl) + "/" + encodeURIComponent(text.slice(0, 200)) + "/" +
         Math.abs([...text].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)).toString(36);
}

async function kvGet(env, key) {
  try {
    const hit = await caches.default.match(new Request(key));
    return hit ? await hit.text() : null;
  } catch (e) {
    return null;
  }
}

async function kvPut(env, key, val) {
  try {
    await caches.default.put(
      new Request(key),
      new Response(val, { headers: { "Cache-Control": `max-age=${CACHE_TTL}` } })
    );
  } catch (e) {}
}

// ---------------------------------------------------------------- 主流程
function splitSentences(q) {
  const text = q.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let parts = text.split("\n");
  if (parts.length === 1 && text.includes("|")) parts = text.split("|");
  return parts;
}

async function translateAll(env, gl, parts, sl, tl) {
  const results = new Array(parts.length).fill("");
  const todo = [];
  let hit = 0;
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].trim()) continue;
    const c = await kvGet(env, cacheUrl(sl, tl, parts[i]));
    if (c) {
      results[i] = c;
      hit++;
    } else todo.push(i);
  }

  const chunks = [];
  for (let i = 0; i < todo.length; i += CHUNK) chunks.push(todo.slice(i, i + CHUNK));

  let cursor = 0;
  async function worker() {
    while (cursor < chunks.length) {
      const idxs = chunks[cursor++];
      const sub = idxs.map((i) => parts[i]);
      try {
        const outs = await translateChunk(env, gl, sub);
        for (let p = 0; p < idxs.length; p++) {
          const v = outs[p];
          if (v) {
            results[idxs[p]] = v;
            await kvPut(env, cacheUrl(sl, tl, parts[idxs[p]]), v);
          }
        }
      } catch (e) {
        console.log("chunk failed: " + (e && e.message));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONC, chunks.length) }, worker));

  let fallback = 0;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].trim() && !results[i]) {
      results[i] = parts[i];
      fallback++;
    }
  }
  return { results, hit, fallback };
}

function toGoogle(parts, tr, sl, dj) {
  const pairs = parts.map((o, i) => [o, tr[i]]);
  if (dj) {
    return {
      sentences: pairs.map(([o, t]) => ({ trans: t, orig: o, backend: 10 })),
      src: sl,
      confidence: 1.0,
      ld_result: { srclangs: [sl], srclangs_confidences: [1.0], extended_srclangs: [sl] },
    };
  }
  return [pairs.map(([o, t]) => [t, o, null, null, 10]), null, sl];
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 鉴权（配了 AUTH_TOKEN 才生效）
    if (env.AUTH_TOKEN) {
      const t = url.searchParams.get("t") || request.headers.get("x-auth") || "";
      if (t !== env.AUTH_TOKEN) return json({ error: "forbidden" }, 403);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, gateway: "dsl-llm-worker", model: env.LLM_MODEL || "gpt-4o-mini" });
    }

    let q = "", sl = "auto", tl = "zh-CN", dj = false;
    if (request.method === "POST") {
      let body = {};
      try {
        body = await request.json();
      } catch (e) {
        const txt = await request.text();
        new URLSearchParams(txt).forEach((v, k) => (body[k] = v));
      }
      q = body.q || body.text || "";
      sl = body.sl || sl;
      tl = body.tl || tl;
      dj = body.dj === true || body.dj === "1" || body.dj === 1;
    } else {
      q = url.searchParams.get("q") || "";
      sl = url.searchParams.get("sl") || sl;
      tl = url.searchParams.get("tl") || tl;
      dj = url.searchParams.get("dj") === "1";
    }

    if (!q) return json({ error: "empty q" }, 400);
    if (!env.LLM_BASE || !env.LLM_KEY) return json({ error: "missing LLM_BASE / LLM_KEY" }, 500);

    const gl = await loadGlossary(env);
    const parts = splitSentences(q);
    const { results, hit, fallback } = await translateAll(env, gl, parts, sl, tl);
    console.log(`req ${parts.length} · hit ${hit} · fallback ${fallback}`);
    return json(toGoogle(parts, results, sl, dj));
  },
};
