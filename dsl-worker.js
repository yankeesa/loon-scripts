/**
 * dsl-worker.js — DualSubs LLM 字幕网关（Cloudflare Worker 版）
 *
 * 与 Python 版（dsl-gateway.py）逻辑等价：假冒 Google 翻译接口，
 * 把 DualSubs 发来的整段字幕交给 LLM 翻译，带术语表、带上下文、带缓存。
 *
 * 部署：Cloudflare Dashboard → Workers & Pages → Create Worker → 粘贴本文件
 * 环境变量（Settings → Variables）：
 *   LLM_BASE   https://open.bigmodel.cn/api/paas/v4   主通道地址（必填）
 *   LLM_KEY    sk-xxxx                               主通道 key（必填）
 *   LLM_MODEL  glm-4-flash,glm-4-plus                主通道模型，可逗号分隔多个做降级
 *   LLM_BASE_2 / LLM_KEY_2 / LLM_MODEL_2             备用通道，可选，主通道失败自动切
 *   LLM_EXTRA  {"thinking":{"type":"disabled"}}      追加进请求体，用于关思考模式
 *   AUTH_TOKEN 自定义一串随机字符                     强烈建议，防别人白嫖
 *   GLOSSARY_BASE 术语表目录（可选，默认用内联术语表，无需联网）
 *
 * 自检：浏览器打开 https://<你的域名>/  应返回 {"ok":true,...}
 */

const CHUNK = 16;             // 每批句数（16 句约 3-4s，批次小漏句少、好补）
const MAX_CONC = 8;           // 并发批数
const LLM_TIMEOUT = 15000;    // 单批 LLM 超时(ms)，Loon 侧等待有限，必须快
const CACHE_TTL = 60 * 60 * 24 * 30;
const GLOSSARY_TTL = 60 * 60 * 6;

const GLOSSARY_INLINE = {
  f1: {"Max Verstappen": "马克斯·维斯塔潘", "Lando Norris": "兰多·诺里斯", "Charles Leclerc": "夏尔·勒克莱尔", "Oscar Piastri": "奥斯卡·皮亚斯特里", "George Russell": "乔治·拉塞尔", "Lewis Hamilton": "刘易斯·汉密尔顿", "Kimi Antonelli": "基米·安东内利", "Andrea Kimi Antonelli": "安德烈亚·基米·安东内利", "Fernando Alonso": "费尔南多·阿隆索", "Carlos Sainz": "卡洛斯·塞恩斯", "Alexander Albon": "亚历山大·阿尔本", "Alex Albon": "亚历山大·阿尔本", "Lance Stroll": "兰斯·斯特罗尔", "Pierre Gasly": "皮埃尔·加斯利", "Esteban Ocon": "埃斯特班·奥康", "Franco Colapinto": "弗朗哥·科拉平托", "Yuki Tsunoda": "角田裕毅", "Isack Hadjar": "伊萨克·哈贾尔", "Oliver Bearman": "奥利弗·贝尔曼", "Liam Lawson": "利亚姆·劳森", "Gabriel Bortoleto": "加布里埃尔·博尔托莱托", "Nico Hulkenberg": "尼科·霍肯伯格", "Nico Hülkenberg": "尼科·霍肯伯格", "Arvid Lindblad": "阿维德·林德布拉德", "Sergio Perez": "塞尔吉奥·佩雷兹", "Valtteri Bottas": "瓦尔特利·博塔斯", "McLaren": "迈凯伦", "Ferrari": "法拉利", "Red Bull Racing": "红牛车队", "Red Bull": "红牛", "Mercedes": "梅赛德斯", "Aston Martin": "阿斯顿·马丁", "Alpine": "阿尔派", "Williams": "威廉姆斯", "Haas": "哈斯", "Racing Bulls": "红牛二队", "RB": "红牛二队", "Sauber": "索伯", "Audi": "奥迪", "Cadillac": "凯迪拉克", "FIA": "国际汽联", "stewards": "赛会干事", "race director": "赛事总监", "Grand Prix": "大奖赛", "pole position": "杆位", "pole": "杆位", "front row": "头排发车", "grid": "发车格", "grid penalty": "发车格罚退", "pit lane": "维修区通道", "pit wall": "指挥台", "pit stop": "进站", "box box": "进站进站", "undercut": "提前进站超越（undercut）", "overcut": "延后进站超越（overcut）", "DRS": "DRS 可调尾翼", "DRS train": "DRS 车队（连续跟车）", "slipstream": "尾流", "tow": "尾流牵引", "dirty air": "乱流", "clean air": "干净气流", "apex": "弯心", "kerb": "路肩", "chicane": "减速弯", "graining": "起粒", "blistering": "起泡", "degradation": "轮胎衰减", "tyre wear": "轮胎磨损", "lock-up": "锁死", "flat spot": "平点", "safety car": "安全车", "virtual safety car": "虚拟安全车", "VSC": "虚拟安全车", "formation lap": "暖胎圈", "out lap": "出场圈", "in lap": "回场圈", "flying lap": "飞驰圈", "parc ferme": "车检封存区", "parc fermé": "车检封存区", "scrutineering": "车检", "sector": "计时段", "traction": "牵引力", "understeer": "转向不足", "oversteer": "转向过度", "brake bias": "刹车平衡", "ERS": "能量回收系统", "MGU-K": "动能回收电机", "MGU-H": "热能回收电机", "floor": "底板", "diffuser": "扩散器", "front wing": "前翼", "rear wing": "尾翼", "sidepod": "侧箱", "halo": "头翼保护装置", "team radio": "车队无线电", "sprint": "冲刺赛", "qualifying": "排位赛", "Q1": "第一节排位", "Q2": "第二节排位", "Q3": "第三节排位", "practice": "练习赛", "chequered flag": "方格旗", "blue flag": "蓝旗", "black and white flag": "黑白旗", "red flag": "红旗"},
  mls: {"Major League Soccer": "美国职业足球大联盟", "MLS": "MLS", "MLS Cup": "MLS 杯", "Leagues Cup": "联赛杯", "Supporters' Shield": "支持者盾", "playoff": "季后赛", "conference": "分区", "offside": "越位", "offside trap": "越位陷阱", "corner": "角球", "penalty": "点球", "penalty shootout": "点球大战", "free kick": "任意球", "set piece": "定位球", "throw-in": "界外球", "goal kick": "门球", "VAR": "视频助理裁判（VAR）", "stoppage time": "补时", "injury time": "伤停补时", "extra time": "加时赛", "aggregate": "总比分", "leg": "回合", "midfield": "中场", "winger": "边锋", "striker": "前锋", "forward": "前锋", "centre-back": "中后卫", "center-back": "中后卫", "full-back": "边后卫", "goalkeeper": "门将", "keeper": "门将", "clean sheet": "零封", "hat-trick": "帽子戏法", "bicycle kick": "倒钩射门", "volley": "凌空抽射", "cross": "传中", "through ball": "直塞", "one-two": "二过一", "counter-attack": "反击", "header": "头球", "own goal": "乌龙球", "assist": "助攻", "tackle": "抢断", "interception": "拦截", "possession": "控球率", "pressing": "逼抢", "high press": "高位逼抢", "formation": "阵型", "substitution": "换人", "yellow card": "黄牌", "red card": "红牌", "booking": "记名警告", "derby": "德比", "fixture": "赛事", "matchday": "比赛日", "kick-off": "开球", "half-time": "中场休息", "full-time": "全场结束"},
  fitness: {"squat": "深蹲", "air squat": "徒手深蹲", "goblet squat": "高脚杯深蹲", "lunge": "弓步", "reverse lunge": "后撤弓步", "walking lunge": "行进弓步", "jumping lunge": "跳跃弓步", "deadlift": "硬拉", "Romanian deadlift": "罗马尼亚硬拉", "single-leg deadlift": "单腿硬拉", "burpee": "波比跳", "plank": "平板支撑", "side plank": "侧平板支撑", "crunch": "卷腹", "sit-up": "仰卧起坐", "push-up": "俯卧撑", "glute bridge": "臀桥", "hip thrust": "臀推", "mountain climber": "登山跑", "jumping jack": "开合跳", "high knees": "高抬腿", "overhead press": "过顶推举", "shoulder press": "肩推", "row": "划船", "bent-over row": "俯身划船", "bicep curl": "二头弯举", "tricep extension": "三头伸展", "lateral raise": "侧平举", "hip hinge": "髋铰链", "core": "核心", "glutes": "臀肌", "hamstrings": "腘绳肌", "quads": "股四头肌", "lats": "背阔肌", "delts": "三角肌", "abs": "腹肌", "obliques": "腹斜肌", "calves": "小腿", "RPE": "自觉用力程度（RPE）", "rep": "次", "reps": "次", "set": "组", "circuit": "循环", "interval": "间歇", "HIIT": "高强度间歇训练", "cool down": "放松整理", "warm up": "热身", "warmup": "热身", "stretch": "拉伸", "mobility": "灵活性训练", "recovery": "恢复", "active recovery": "主动恢复", "form": "动作姿势", "engage your core": "收紧核心", "brace your core": "绷紧核心", "keep your chest up": "挺胸", "drive through your heels": "脚跟发力", "full range of motion": "完整活动幅度", "modify": "降阶调整", "modification": "降阶动作", "regression": "降阶", "progression": "进阶", "tempo": "节奏控制", "hold": "保持", "pulse": "小幅脉冲", "rest": "休息", "let's go": "开始", "halfway there": "过半了", "last round": "最后一轮", "finish strong": "坚持到底"},
  general: {"OK": "好", "okay": "好", "yeah": "是啊", "yep": "对", "nope": "不", "hey": "嘿", "wow": "哇", "damn": "该死", "hell": "见鬼", "shit": "该死", "gonna": "要", "wanna": "想", "gotta": "得", "kinda": "有点", "ain't": "不是", "you know": "你知道", "I mean": "我是说", "right now": "现在", "come on": "拜托", "hold on": "等等", "no way": "不可能", "let's go": "走", "watch out": "小心", "take care": "保重", "thank you": "谢谢", "excuse me": "打扰一下", "I'm sorry": "对不起", "are you kidding": "你在开玩笑吗", "what the hell": "搞什么", "oh my god": "我的天", "for God's sake": "看在上帝的份上", "Mr.": "先生", "Mrs.": "太太", "Ms.": "女士", "Dr.": "博士", "Detective": "警探", "Officer": "警官", "Sergeant": "警佐", "Captain": "队长", "Agent": "探员", "Boss": "老板", "Sir": "先生", "Madam": "女士", "FBI": "联邦调查局", "CIA": "中央情报局", "NYPD": "纽约警察局", "SWAT": "特警队"},
};

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
  // 术语表已内联，不依赖外网（避免国内拉 GitHub raw 失败导致退化成无术语机器翻译）
  if (!env.GLOSSARY_BASE) return GLOSSARY_INLINE;
  const now = Date.now();
  if (GL_CACHE.data && now - GL_CACHE.t < GLOSSARY_TTL * 1000) return GL_CACHE.data;
  const base = env.GLOSSARY_BASE.replace(/\/+$/, "");
  const out = JSON.parse(JSON.stringify(GLOSSARY_INLINE));
  await Promise.all(
    Object.keys(GLOSSARY_INLINE).map(async (dom) => {
      try {
        const r = await fetch(`${base}/${dom}.json`, { cf: { cacheTtl: GLOSSARY_TTL } });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        const o = {};
        for (const k of Object.keys(j)) if (!k.startsWith("_")) o[k] = j[k];
        if (Object.keys(o).length) out[dom] = o;
      } catch (e) {}
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
// 主通道失败自动切备用通道（防某一家 API 抖动导致整片字幕空白）。
// 记 60 秒降级窗口：主通道失败过一次，接下来一分钟直接走备用，不再逐批重试。
let DEGRADED_UNTIL = 0;

function splitModels(s) {
  return String(s || "").split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}

function channels(env) {
  const list = [];
  // 主通道：LLM_MODEL 支持逗号分隔多个模型，按顺序逐个降级（同 key 同 base）
  const m1 = splitModels(env.LLM_MODEL);
  if (env.LLM_BASE && env.LLM_KEY) {
    for (const m of (m1.length ? m1 : ["gpt-4o-mini"])) {
      list.push({ base: env.LLM_BASE, key: env.LLM_KEY, model: m, tag: "主" });
    }
  }
  // 备用通道：另一家服务商
  if (env.LLM_BASE_2 && env.LLM_KEY_2) {
    const m2 = splitModels(env.LLM_MODEL_2 || env.LLM_MODEL);
    for (const m of (m2.length ? m2 : ["gpt-4o-mini"])) {
      list.push({ base: env.LLM_BASE_2, key: env.LLM_KEY_2, model: m, tag: "备" });
    }
  }
  return list.filter((c) => c.base && c.key);
}

function extraBody(env) {
  if (!env.LLM_EXTRA) return {};
  try {
    const o = JSON.parse(env.LLM_EXTRA);
    return o && typeof o === "object" ? o : {};
  } catch (e) {
    console.log("LLM_EXTRA 解析失败，已忽略");
    return {};
  }
}

async function callOne(chan, messages, extra) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT);
  try {
    const res = await fetch(`${chan.base.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + chan.key,
      },
      body: JSON.stringify(Object.assign({ model: chan.model, messages, temperature: 0.2 }, extra)),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200));
    const body = await res.json();
    const content = body?.choices?.[0]?.message?.content || "";
    if (!content) throw new Error("空回复");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

async function llmChat(env, messages) {
  const chans = channels(env);
  if (!chans.length) throw new Error("未配置任何 LLM 通道");
  let order = chans.map((_, i) => i);
  if (Date.now() < DEGRADED_UNTIL && order.length > 1) {
    order = order.slice(1).concat(order.slice(0, 1));
  }
  const extra = extraBody(env);
  let lastErr = null;
  for (const i of order) {
    try {
      const out = await callOne(chans[i], messages, extra);
      if (i !== 0) console.log("已走备用通道 " + (i + 1));
      return out;
    } catch (e) {
      lastErr = e;
      console.log("通道 " + (i + 1) + "(" + chans[i].model + ") 失败: " + (e && e.message));
      if (i === 0 && chans.length > 1) DEGRADED_UNTIL = Date.now() + 60000;
    }
  }
  throw lastErr || new Error("所有通道均失败");
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

  // 跑一批索引；size=每批句数，conc=并发数
  async function pass(idxs, size, conc) {
    const chunks = [];
    for (let i = 0; i < idxs.length; i += size) chunks.push(idxs.slice(i, i + size));
    let cursor = 0;
    async function worker() {
      while (cursor < chunks.length) {
        const ids = chunks[cursor++];
        const sub = ids.map((i) => parts[i]);
        try {
          const outs = await translateChunk(env, gl, sub);
          for (let p = 0; p < ids.length; p++) {
            const v = outs[p];
            if (v) {
              results[ids[p]] = v;
              await kvPut(env, cacheUrl(sl, tl, parts[ids[p]]), v);
            }
          }
        } catch (e) {
          console.log("chunk failed: " + (e && e.message));
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(conc, chunks.length) }, worker));
  }

  await pass(todo, CHUNK, MAX_CONC);

  // 编号守恒兜底：LLM 偶尔会漏几行，用小批补译，最多两轮
  for (let round = 1; round <= 2; round++) {
    const miss = todo.filter((i) => !results[i]);
    if (!miss.length) break;
    console.log(`补译第 ${round} 轮 · ${miss.length} 句`);
    await pass(miss, 8, 4);
  }

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

    // 自检入口：/health，或 / 且未带 q（浏览器直接打开时用）
    // 注意：必须排除带 q 的请求，否则 DualSubs 走根路径的翻译请求会被误判为自检
    const hasQ = !!(url.searchParams.get("q") || url.searchParams.get("text"));
    if (url.pathname === "/health" || (url.pathname === "/" && !hasQ && request.method === "GET")) {
      const chans = channels(env);
      return json({
        ok: true,
        gateway: "dsl-llm-worker",
        channels: chans.map((c) => ({ model: c.model, base: c.base })),
        degraded: Date.now() < DEGRADED_UNTIL,
      });
    }

    // 一键自检：真调一次 LLM，手机打开即知通不通
    if (url.pathname === "/selftest") {
      const chans = channels(env);
      if (!chans.length) return json({ ok: false, error: "未配置 LLM 通道（LLM_BASE / LLM_KEY）" }, 500);
      const t0 = Date.now();
      try {
        const out = await llmChat(env, [
          { role: "system", content: "你是字幕译者，只输出译文本身，不要任何解释。" },
          { role: "user", content: "译为简体中文：Safety car is out, box box box." },
        ]);
        return json({
          ok: true,
          ms: Date.now() - t0,
          model: chans[0].model,
          fallbackModels: chans.slice(1).map((c) => c.model),
          sample: out.trim().slice(0, 100),
          glossary: Object.keys(GLOSSARY_INLINE).map((k) => k + ":" + Object.keys(GLOSSARY_INLINE[k]).length),
        });
      } catch (e) {
        return json({ ok: false, ms: Date.now() - t0, error: String((e && e.message) || e) }, 500);
      }
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
    if (!channels(env).length) return json({ error: "未配置 LLM 通道（LLM_BASE / LLM_KEY）" }, 500);

    const gl = await loadGlossary(env);
    const parts = splitSentences(q);
    const { results, hit, fallback } = await translateAll(env, gl, parts, sl, tl);
    console.log(`req ${parts.length} · hit ${hit} · fallback ${fallback}`);
    return json(toGoogle(parts, results, sl, dj));
  },
};
