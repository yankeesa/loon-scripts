/**
 * dsl-vtt.js v5 — Fitness+ 字幕直译（多通道：totokens 中转站 + 智谱直连）
 *
 * 拦截 hls(-svod).itunes.apple.com 的 .webvtt 字幕分片，逐片翻译并注入中文。
 * 通道链：totokens(gpt-5.6-luna) → 智谱 glm-5.3-flash → 智谱 glm-4-flash（免费兜底）
 * - 额度/鉴权类错误立即跳过并标记 30 分钟，不做退避重试（避免拖死播放器）
 * - 缓存按分片 URL 存本机；模式 dsl_vtt_mode：zh = 纯中文（默认）| both = 双语 | off = 关闭
 */

const ZP_KEY_BUILTIN = "3e9f3358728e4033881872133abb9b29.xOjyRjrLkoVnGTR7";   // 内置 Key（本机存储有 zp_key 时优先用本机）
const TT_KEY_BUILTIN = "sk-f9a3834f49fad3e94602f35d253b23df6bc927748a8f2a171c7191d0e9f41059";  // totokens 中转站
const ZP_KEY = ($persistentStore.read("zp_key") || "").trim() || ZP_KEY_BUILTIN;
const TT_KEY = ($persistentStore.read("tt_key") || "").trim() || TT_KEY_BUILTIN;
const ZP_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const TT_URL = "https://totokens.cc/v1/chat/completions";

// 提供商链：中转站（译文质量最好）→ 智谱 5.3（需资源包）→ 智谱 4-flash（免费、4 秒级兜底）
// totokens 实测所有模型名都路由到同一后端 gpt-5.6-sol，故只留一个入口；延迟 3~17 秒波动
const PROVIDERS = [
    { id: "tt",     url: TT_URL, key: TT_KEY, model: "gpt-5.6-luna",  effort: "minimal", timeout: 14000 },
    { id: "glm53",  url: ZP_URL, key: ZP_KEY, model: "glm-5.3-flash", effort: "low",     timeout: 16000 },
    { id: "glm4",   url: ZP_URL, key: ZP_KEY, model: "glm-4-flash",   effort: "low",     timeout: 9000 }
];
const DOWN_KEY = "zp_down_";        // 提供商不可用标记（30 分钟自愈，充值后自动恢复）
const DOWN_TTL = 30 * 60 * 1000;
const TIMEOUT = 30000;                           // 保留：单次 LLM 超时兜底
const CHUNK = 12;    // 并行翻译：每块句数（中转站偏慢，块小一点摊平延迟）
const CONC  = 6;     // 并行翻译：并发数
const DEADLINE = 24000;  // 翻译总时限，超时放行已有结果，不让播放器干等

const GLOSSARY = {
  "squat": "深蹲",
  "air squat": "徒手深蹲",
  "goblet squat": "高脚杯深蹲",
  "lunge": "弓步",
  "reverse lunge": "后撤弓步",
  "walking lunge": "行进弓步",
  "jumping lunge": "跳跃弓步",
  "deadlift": "硬拉",
  "Romanian deadlift": "罗马尼亚硬拉",
  "single-leg deadlift": "单腿硬拉",
  "burpee": "波比跳",
  "plank": "平板支撑",
  "side plank": "侧平板支撑",
  "crunch": "卷腹",
  "sit-up": "仰卧起坐",
  "push-up": "俯卧撑",
  "glute bridge": "臀桥",
  "hip thrust": "臀推",
  "mountain climber": "登山跑",
  "jumping jack": "开合跳",
  "high knees": "高抬腿",
  "overhead press": "过顶推举",
  "shoulder press": "肩推",
  "row": "划船",
  "bent-over row": "俯身划船",
  "bicep curl": "二头弯举",
  "tricep extension": "三头伸展",
  "lateral raise": "侧平举",
  "hip hinge": "髋铰链",
  "core": "核心",
  "glutes": "臀肌",
  "hamstrings": "腘绳肌",
  "quads": "股四头肌",
  "lats": "背阔肌",
  "delts": "三角肌",
  "abs": "腹肌",
  "obliques": "腹斜肌",
  "calves": "小腿",
  "RPE": "自觉用力程度（RPE）",
  "rep": "次",
  "reps": "次",
  "set": "组",
  "circuit": "循环",
  "interval": "间歇",
  "HIIT": "高强度间歇训练",
  "cool down": "放松整理",
  "warm up": "热身",
  "warmup": "热身",
  "stretch": "拉伸",
  "mobility": "灵活性训练",
  "recovery": "恢复",
  "active recovery": "主动恢复",
  "form": "动作姿势",
  "engage your core": "收紧核心",
  "brace your core": "绷紧核心",
  "keep your chest up": "挺胸",
  "drive through your heels": "脚跟发力",
  "full range of motion": "完整活动幅度",
  "modify": "降阶调整",
  "modification": "降阶动作",
  "regression": "降阶",
  "progression": "进阶",
  "tempo": "节奏控制",
  "hold": "保持",
  "pulse": "小幅脉冲",
  "rest": "休息",
  "let's go": "开始",
  "halfway there": "过半了",
  "last round": "最后一轮",
  "finish strong": "坚持到底",
  "OK": "好",
  "okay": "好",
  "yeah": "是啊",
  "yep": "对",
  "nope": "不",
  "hey": "嘿",
  "wow": "哇",
  "damn": "该死",
  "hell": "见鬼",
  "shit": "该死",
  "gonna": "要",
  "wanna": "想",
  "gotta": "得",
  "kinda": "有点",
  "ain't": "不是",
  "you know": "你知道",
  "I mean": "我是说",
  "right now": "现在",
  "come on": "拜托",
  "hold on": "等等",
  "no way": "不可能",
  "watch out": "小心",
  "take care": "保重",
  "thank you": "谢谢",
  "excuse me": "打扰一下",
  "I'm sorry": "对不起",
  "are you kidding": "你在开玩笑吗",
  "what the hell": "搞什么",
  "oh my god": "我的天",
  "for God's sake": "看在上帝的份上",
  "Mr.": "先生",
  "Mrs.": "太太",
  "Ms.": "女士",
  "Dr.": "博士",
  "Detective": "警探",
  "Officer": "警官",
  "Sergeant": "警佐",
  "Captain": "队长",
  "Agent": "探员",
  "Boss": "老板",
  "Sir": "先生",
  "Madam": "女士",
  "FBI": "联邦调查局",
  "CIA": "中央情报局",
  "NYPD": "纽约警察局",
  "SWAT": "特警队",
};

// 路由：
// - 带 dslzh=1 标记 → 简体中文轨分段，纯中文
// - 官方中文轨（zh/cmn/yue）→ 放行
// - 英文字幕轨 → 按 dsl_vtt_mode 处理：zh = 替换为纯中文（默认）| both = 行对齐双语 | off = 放行
const ROUTE_ZH = /[?&]dslzh=1/.test($request.url);
const IS_ZH_TRACK = /[-_.](zh|cmn|yue)[-_]/i.test($request.url);
const MODE = $persistentStore.read("dsl_vtt_mode") || "zh";   // zh=纯中文 | both=双语 | off=关闭
if (!ZP_KEY) {
    console.log("[VTT] 未设置智谱 Key（本机键 zp_key），放行原文");
    $done({});
} else if (ROUTE_ZH) {
    main(true);
} else if (IS_ZH_TRACK || MODE === "off") {
    console.log("[VTT] 中文轨或模式 off，放行");
    $done({});
} else {
    main(false);
}

function main(zhTrack) {
    const raw = (typeof $response !== "undefined" && $response.body) || "";
    if (!raw || !/WEBVTT/.test(raw.slice(0, 200))) {
        console.log("[VTT] 非 WebVTT 内容，放行");
        $done({});
        return;
    }
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const blocks = raw.replace(/\r\n/g, "\n").split("\n\n");
    const header = [];
    const cues = [];
    blocks.forEach(function (b) {
        const t = b.trim();
        if (!t) return;
        if (/^WEBVTT|^X-TIMESTAMP-MAP|^NOTE|^STYLE/.test(t.split("\n")[0]) && cues.length === 0) {
            header.push(t);
        } else {
            cues.push(t);
        }
    });

    // 每个 cue 提取「正文行数组」（去掉序号行和时间轴行）
    const cueLines = cues.map(function (c) {
        return c.split("\n").filter(function (line) {
            return !/^\d+$/.test(line.trim()) && !line.includes("-->");
        });
    });

    // 收集去重后的唯一句（按首次出现顺序）
    const uniq = [];
    const lineIndex = {};   // 纯文本 -> uniq 下标
    cueLines.forEach(function (lines) {
        lines.forEach(function (line) {
            const plain = line.replace(/<[^>]+>/g, "").trim();
            if (!plain) return;
            if (!(plain in lineIndex)) {
                lineIndex[plain] = uniq.length;
                uniq.push(plain);
            }
        });
    });

    if (!uniq.length) { $done({}); return; }

    // 分片级缓存：同一分片 URL 只翻一次，存本机（v4 键）
    const ckey = "vtt4_" + hash($request.url);
    const cached = $persistentStore.read(ckey);
    if (cached) {
        try {
            const arr = JSON.parse(cached);
            if (Array.isArray(arr) && arr.length === uniq.length) {
                console.log("[VTT] 缓存命中 " + uniq.length + " 句");
                finish(cues, cueLines, header, arr, lineIndex, eol, zhTrack, "cache");
                return;
            }
        } catch (e) {}
    }

    console.log("[VTT] 解析 " + cues.length + " 条 cue / " + uniq.length + " 句，分块并行多通道翻译");
    const terms = Object.keys(GLOSSARY).map(function (k) { return k + " => " + GLOSSARY[k]; }).join("\n");
    const sys = "你是专业健身课程字幕译者。逐条翻译成简体中文，口语自然、简短，每条都是独立短句。\n术语必须按以下对照表翻译：\n" + terms +
        "\n\n只输出 JSON 对象，key 为编号字符串（如 \"1\"、\"2\"），value 为对应译文，不要输出任何其他内容。";

    translateChunks(uniq, sys, function (trans, used) {
        // 命中 90% 以上才写缓存，避免坏结果永久缓存
        const filled = trans ? trans.filter(Boolean).length : 0;
        if (filled >= uniq.length * 0.9) $persistentStore.write(ckey, JSON.stringify(trans));
        console.log("[VTT] 缓存写入 " + filled + "/" + uniq.length);
        finish(cues, cueLines, header, trans, lineIndex, eol, zhTrack, used);
    });
}

function finish(cues, cueLines, header, trans, lineIndex, eol, zhTrack, used) {
    const replaceMode = zhTrack || MODE === "zh";   // 纯中文：整行替换；双语：英文行下加中文行
    const mark = debugOn() ? (used ? "〔DSL·" + used + "〕" : "〔DSL 未翻译〕") : "";   // 屏幕诊断标记
    let stamped = false;
    const out = cues.map(function (c, i) {
        const lines = c.split("\n");
        const head = lines.filter(function (line) {
            return /^\d+$/.test(line.trim()) || line.includes("-->");
        });
        const bodyLines = cueLines[i] || [];
        let content = bodyLines.map(function (line) {
            const plain = line.replace(/<[^>]+>/g, "").trim();
            const tl = plain && (plain in lineIndex) && trans ? String(trans[lineIndex[plain]] || "").trim() : "";
            if (!tl) return line;
            return replaceMode ? tl : line + "\n" + tl;
        }).join("\n");
        if (content && mark && !stamped) { content = content + "\n" + mark; stamped = true; }
        if (!content) return head.join("\n");
        return head.concat([content]).join("\n");
    });
    const body = header.concat(out).join("\n\n") + "\n";
    console.log("[VTT] 注入完成 · " + (replaceMode ? "纯中文" : "双语") + " · 通道 " + (used || "无") + (trans ? "" : " · 翻译失败放行原文"));
    $done({ body: body.replace(/\n/g, eol) });
}

// 屏幕诊断标记开关：dsl_debug="0" 关闭；未设置时默认开启 10 分钟（便于确认脚本是否生效）
function debugOn() {
    const v = $persistentStore.read("dsl_debug");
    if (v === "0") return false;
    if (v === "1") return true;
    let until = parseInt($persistentStore.read("dsl_debug_until") || "0", 10);
    if (!until) {
        until = Date.now() + 10 * 60 * 1000;
        $persistentStore.write(String(until), "dsl_debug_until");
    }
    return Date.now() < until;
}

// 并行分块翻译：切块 → 并发请求 → 汇总 → 超时兜底放行
function translateChunks(uniq, sys, cb) {
    const n = uniq.length;
    const trans = new Array(n).fill("");
    const starts = [];
    for (let s = 0; s < n; s += CHUNK) starts.push(s);
    const totalChunks = starts.length;
    let remaining = starts.length;
    let finished = false;
    let used = "";          // 实际生效的通道（诊断用）
    const t0 = Date.now();

    function done() {
        if (finished) return;
        finished = true;
        const filled = trans.filter(Boolean).length;
        console.log("[VTT] 翻译完成 " + filled + "/" + n + " 句 · 通道 " + (used || "无") + " · 耗时 " + Math.round((Date.now() - t0) / 1000) + "s");
        if (filled === 0) notify("翻译失败", "所有通道都没返回结果，已放行英文原文。请检查额度或网络。");
        cb(filled > 0 ? trans : null, used);
    }

    // 全局兜底：到点即交付
    setTimeout(function () {
        if (!finished) { console.log("[VTT] 超过 " + DEADLINE / 1000 + "s，先放行避免播放器卡住"); done(); }
    }, DEADLINE);

    function runOne(start, cb2) {
        const lines = uniq.slice(start, start + CHUNK);
        const numbered = lines.map(function (t, i) { return "[" + (i + 1) + "] " + t; }).join("\n");
        (function nextProvider(pi) {
            if (finished) return;
            if (pi >= PROVIDERS.length) { cb2(); return; }
            const p = PROVIDERS[pi];
            if (isDown(p.id)) { nextProvider(pi + 1); return; }   // 已知不可用（额度/故障），直接跳过
            callLLM(p, sys, numbered, function (obj) {
                if (finished) return;
                if (!obj) { nextProvider(pi + 1); return; }
                for (let i = 0; i < lines.length; i++) {
                    const v = obj[String(i + 1)];
                    if (v) trans[start + i] = String(v).trim();
                }
                used = p.id;
                cb2();
            });
        })(0);
    }

    // worker-pool：CONC 个并发，各自取下一块
    function next() {
        if (!starts.length || finished) return;
        const start = starts.shift();
        runOne(start, function () {
            remaining--;
            console.log("[VTT] 块完成 " + (totalChunks - remaining) + "/" + totalChunks);
            next();
            if (remaining === 0) done();
        });
    }
    for (let i = 0; i < CONC; i++) next();
}

function callLLM(p, sys, user, cb, attempt) {
    attempt = attempt || 0;
    const tag = p.id + "(" + p.model + ")";
    $httpClient.post({
        url: p.url,
        headers: {
            "Authorization": "Bearer " + p.key,
            "Content-Type": "application/json",
            // 中转站走 Cloudflare，默认 UA 会被 403，伪装浏览器
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
        },
        body: JSON.stringify({ model: p.model, messages: [ { role: "system", content: sys }, { role: "user", content: user } ], temperature: 0.2, reasoning_effort: p.effort, max_tokens: 2000 }),
        timeout: p.timeout || TIMEOUT
    }, function (err, resp, data) {
        const status = resp && resp.status;
        const body = typeof data === "string" ? data : "";
        // 余额/资源包不足（1113 会以 429 返回）：标记 30 分钟并立刻换下一个，绝不退避等待
        if (status === 429 && /1113|余额不足|资源包/.test(body)) {
            markDown(p.id);
            console.log("[VTT] " + tag + " 无可用资源包(1113)，标记 30 分钟并切换");
            cb(null);
            return;
        }
        if (status === 429 && attempt < 1) {
            // 真限流：等 3s 重试一次，仍失败就换下一个（快速失败，别拖住播放器）
            console.log("[VTT] " + tag + " 限流 429，3s 后重试一次");
            setTimeout(function () { callLLM(p, sys, user, cb, attempt + 1); }, 3000);
            return;
        }
        if (err || !resp || resp.status !== 200) {
            console.log("[VTT] " + tag + " 失败: " + (err ? (err.message || err) : (resp && resp.status) || "unknown") + (body ? " · " + body.slice(0, 100) : ""));
            if (status === 401 || status === 403) markDown(p.id);   // 鉴权/被墙类错误，短期跳过
            cb(null);
            return;
        }
        try {
            const j = JSON.parse(data);
            const txt = String(j.choices[0].message.content || "").replace(/```json|```/g, "").trim();
            const obj = JSON.parse(txt);
            cb(obj);
        } catch (e) {
            console.log("[VTT] " + tag + " 解析失败: " + e.message);
            cb(null);
        }
    });
}

// 提供商不可用标记：额度用光后短期跳过，避免每块都白撞一次 429
function isDown(model) {
    const t = parseInt($persistentStore.read(DOWN_KEY + model) || "0", 10);
    return t > Date.now();
}
function markDown(model) {
    $persistentStore.write(String(Date.now() + DOWN_TTL), DOWN_KEY + model);
}

// 失败通知（tvOS 上 $notification 可能不存在，静默忽略）
function notify(sub, body) {
    try {
        if (typeof $notification !== "undefined" && $notification.post) $notification.post("Fitness+ 字幕", sub, body);
    } catch (e) {}
}

function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
    return (h >>> 0).toString(36);
}
