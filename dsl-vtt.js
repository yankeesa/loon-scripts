/**
 * dsl-vtt.js — Fitness+ / Apple 字幕直接翻译注入（绕过 DualSubs 正则失效）
 *
 * 拦截 hls(-svod).itunes.apple.com 的新版 .webvtt 字幕（无 subtype 参数），
 * 提取全部 cue 文本 → LLM 网关整段翻译 → 注入中文后原样返回。
 *
 * 模式（持久化键 dsl_vtt_mode）：both = 双语（默认）| zh = 仅中文
 */

const GW_DEFAULT =
    "https://dsl-llm.yangke19990916.workers.dev/translate?t=d2ac16b888f6538e0b95b6815c73b6fd" +
    ", http://192.168.31.50:8787/translate";

const GW_LIST = ($persistentStore.read("dsl_gw") || GW_DEFAULT)
    .split(",").map(function (s) { return s.trim().replace(/\/+$/, ""); }).filter(Boolean);

const MODE = $persistentStore.read("dsl_vtt_mode") || "both";
const TIMEOUT = 120;

// 中文轨直接放行（已有官方中文就不用翻）
if (/[-_.](zh|cmn|yue)[-_]/i.test($request.url)) {
    console.log("[VTT] 中文轨，放行");
    $done({});
} else {
// ---------- WebVTT 解析 ----------
const raw = (typeof $response !== "undefined" && $response.body) || "";
if (!raw || !/WEBVTT/.test(raw.slice(0, 200))) {
    console.log("[VTT] 非 WebVTT 内容，放行");
    $done({});
} else {
    main();
}

function main() {
    // 保留头部（WEBVTT / X-TIMESTAMP-MAP）
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

    const texts = cues.map(function (c) {
        return c.split("\n").filter(function (line) {
            return !/^\d+$/.test(line.trim()) && !line.includes("-->");
        }).join(" ").replace(/<[^>]+>/g, "").trim();
    });

    console.log("[VTT] 解析 " + cues.length + " 条字幕，开始翻译");

    translateAll(texts, function (trans) {
        const out = cues.map(function (c, i) {
            const lines = c.split("\n");
            const tl = trans && trans[i] ? trans[i] : "";
            if (!tl) return c;
            // 双语：原文行 + 译文行；仅中文：替换文本行
            const body = lines.filter(function (line) {
                return !/^\d+$/.test(line.trim()) && !line.includes("-->");
            });
            const head = lines.filter(function (line) {
                return /^\d+$/.test(line.trim()) || line.includes("-->");
            });
            const content = MODE === "zh" ? tl : body.join("\n") + "\n" + tl;
            return head.concat([content]).join("\n");
        });
        const body = header.concat(out).join("\n\n") + "\n";
        console.log("[VTT] 注入完成 · 模式 " + MODE);
        $done({ body: body.replace(/\n/g, eol) });
    });
}

// ---------- 翻译 ----------
function translateAll(texts, cb) {
    const q = texts.join("\n");
    const payload = JSON.stringify({ q: q, sl: "en", tl: "zh-CN", dj: true });

    function tryOne(i) {
        if (i >= GW_LIST.length) {
            console.log("[VTT] 网关均不可用，放行原文");
            $done({});
            return;
        }
        $httpClient.post(
            { url: GW_LIST[i], headers: { "Content-Type": "application/json" }, body: payload, timeout: TIMEOUT },
            function (err, resp, data) {
                let trans = null;
                if (!err && data) {
                    try {
                        const obj = JSON.parse(data);
                        if (obj && obj.sentences && obj.sentences.length) {
                            trans = obj.sentences.map(function (s) { return (s.trans || "").trim(); });
                        }
                    } catch (e) {}
                }
                if (!trans) {
                    console.log("[VTT] 网关 " + GW_LIST[i] + " 失败(" + (err || (resp && resp.status) || "bad") + ")，下一个");
                    tryOne(i + 1);
                    return;
                }
                cb(trans);
            }
        );
    }
    if (!texts.filter(Boolean).length) { $done({}); return; }
    tryOne(0);
}
}
