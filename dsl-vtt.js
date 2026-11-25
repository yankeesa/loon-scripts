/**
 * dsl-vtt.js v3 — Fitness+ 字幕直译（直连智谱 API，不依赖 Worker/代理）
 *
 * 拦截 hls(-svod).itunes.apple.com 的 .webvtt 字幕分片，逐片翻译并注入中文。
 * - 直连 open.bigmodel.cn（国内直连可达）
 * - 术语表内嵌，缓存按分片 URL 存本机
 * - 模式（持久化键 dsl_vtt_mode）：both = 双语（默认）| zh = 仅中文
 *
 * v4：配合 dsl-m3u8.js 的「简体中文」字幕轨方案。
 * - URL 带 ?dslzh=1（复制出来的简体中文轨分段）→ 整段翻译为纯中文
 * - 其余英文字幕分段 → 放行不动（双语叠加模式已停用）
 */

const ZP_KEY = "3e9f3358728e4033881872133abb9b29.xOjyRjrLkoVnGTR7";
const ZP_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODELS = ["glm-4-air", "glm-4-flashx"];   // 降级链
const TIMEOUT = 30000;                           // 单次 LLM 超时

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
if (ROUTE_ZH) {
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
                finish(cues, cueLines, header, arr, lineIndex, eol, zhTrack);
                return;
            }
        } catch (e) {}
    }

    console.log("[VTT] 解析 " + cues.length + " 条 cue / " + uniq.length + " 句，直连智谱翻译");
    const terms = Object.keys(GLOSSARY).map(function (k) { return k + " => " + GLOSSARY[k]; }).join("\n");
    const sys = "你是专业健身课程字幕译者。逐条翻译成简体中文，口语自然、简短，每条都是独立短句。\n术语必须按以下对照表翻译：\n" + terms +
        "\n\n只输出 JSON 对象，key 为编号字符串（如 \"1\"、\"2\"），value 为对应译文，不要输出任何其他内容。";
    const numbered = uniq.map(function (t, i) { return "[" + (i + 1) + "] " + t; }).join("\n");

    translate(0, sys, numbered, function (trans) {
        if (trans) $persistentStore.write(ckey, JSON.stringify(trans));
        finish(cues, cueLines, header, trans, lineIndex, eol, zhTrack);
    });
}

function finish(cues, cueLines, header, trans, lineIndex, eol, zhTrack) {
    const replaceMode = zhTrack || MODE === "zh";   // 纯中文：整行替换；双语：英文行下加中文行
    const out = cues.map(function (c, i) {
        const lines = c.split("\n");
        const head = lines.filter(function (line) {
            return /^\d+$/.test(line.trim()) || line.includes("-->");
        });
        const bodyLines = cueLines[i] || [];
        const content = bodyLines.map(function (line) {
            const plain = line.replace(/<[^>]+>/g, "").trim();
            const tl = plain && (plain in lineIndex) && trans ? String(trans[lineIndex[plain]] || "").trim() : "";
            if (!tl) return line;
            return replaceMode ? tl : line + "\n" + tl;
        }).join("\n");
        if (!content) return head.join("\n");
        return head.concat([content]).join("\n");
    });
    const body = header.concat(out).join("\n\n") + "\n";
    console.log("[VTT] 注入完成 · " + (replaceMode ? "纯中文" : "双语") + (trans ? "" : " · 翻译失败放行原文"));
    $done({ body: body.replace(/\n/g, eol) });
}

// 直连智谱：编号守恒 + 漏句补译
function translate(mi, sys, numbered, cb) {
    if (mi >= MODELS.length) { cb(null); return; }
    callLLM(MODELS[mi], sys, numbered, function (obj) {
        if (!obj) { translate(mi + 1, sys, numbered, cb); return; }
        const all = numbered.split("\n");
        const n = all.length;
        const trans = new Array(n).fill("");
        for (let i = 1; i <= n; i++) {
            const v = obj[String(i)];
            if (v) trans[i - 1] = String(v).trim();
        }
        const miss = [];
        for (let i = 0; i < n; i++) if (!trans[i] && all[i].replace(/^\[\d+\] /, "").trim()) miss.push(i);
        if (miss.length) {
            console.log("[VTT] 漏 " + miss.length + " 句，补译");
            const sub = miss.map(function (i) { return "[" + (i + 1) + "] " + all[i].replace(/^\[\d+\] /, ""); }).join("\n");
            callLLM(MODELS[mi], sys, sub, function (obj2) {
                if (obj2) miss.forEach(function (i, p) { const v = obj2[String(p + 1)]; if (v) trans[i] = String(v).trim(); });
                cb(trans);
            });
        } else {
            cb(trans);
        }
    });
}

function callLLM(model, sys, user, cb) {
    $httpClient.post({
        url: ZP_URL,
        headers: { "Authorization": "Bearer " + ZP_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ model: model, messages: [ { role: "system", content: sys }, { role: "user", content: user } ], temperature: 0.2 }),
        timeout: TIMEOUT
    }, function (err, resp, data) {
        if (err || !resp || resp.status !== 200) {
            console.log("[VTT] " + model + " 失败: " + (err ? err.message || err : (resp && resp.status) || "unknown"));
            cb(null);
            return;
        }
        try {
            const j = JSON.parse(data);
            const txt = j.choices[0].message.content.replace(/```json|```/g, "").trim();
            const obj = JSON.parse(txt);
            cb(obj);
        } catch (e) {
            console.log("[VTT] " + model + " 解析失败: " + e.message);
            cb(null);
        }
    });
}

function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
    return (h >>> 0).toString(36);
}
