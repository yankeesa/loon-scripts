/**
 * dsl-llm.js v3 — DualSubs 翻译后端替换为智谱 GLM（直连，无中转）
 *
 * 拦住 DualSubs 发往 Google 翻译的请求（两种端点），本地直连智谱翻译后
 * 按 Google 的响应格式返回，DualSubs 无感知。这样字幕轨注入仍由 DualSubs 完成
 * （电视端需要它配合 iRingo），译文换成 GLM。
 *
 * 端点与返回格式：
 *   /translate_a/t (dict-chrome-ex) → ["译1\r译2\r..."]
 *   /translate_a/single?dj=1        → { sentences:[{trans,orig}], src }
 *   /translate_a/single (无 dj)     → [[[译文,原文,...],...], null, src]
 */

const ZP_KEY_BUILTIN = "3e9f3358728e4033881872133abb9b29.xOjyRjrLkoVnGTR7";
const ZP_KEY = ($persistentStore.read("zp_key") || "").trim() || ZP_KEY_BUILTIN;
const ZP_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODELS = ["glm-4-air", "glm-4-flashx"];
const TIMEOUT = 30000;
const CHUNK = 24;
const CONC = 6;

const url = $request.url;

function param(name) {
    const m = url.match(new RegExp("[?&]" + name + "=([^&]*)"));
    if (!m) return "";
    try {
        return decodeURIComponent(m[1].replace(/\+/g, " "));
    } catch (e) {
        return m[1];
    }
}

function fromBody(name) {
    const body = typeof $request !== "undefined" && $request.body ? $request.body : "";
    if (!body) return "";
    try {
        const m = body.match(new RegExp("(?:^|&)" + name + "=([^&]*)"));
        if (m) return decodeURIComponent(m[1].replace(/\+/g, " "));
    } catch (e) {}
    try {
        const o = JSON.parse(body);
        if (o && o[name] !== undefined) return String(o[name]);
    } catch (e) {}
    return "";
}

const q = param("q") || fromBody("q");
const sl = param("sl") || fromBody("sl") || "auto";
const tl = param("tl") || fromBody("tl") || "zh-CN";
const dj = /[?&]dj=1(&|$)/.test(url) || fromBody("dj") === "1" || fromBody("dj") === "true";

if (!q) {
    $done({});
} else {
    main();
}

function main() {
    const lines = q.split("\n");
    const idx = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].trim()) idx.push(i);

    if (!idx.length) { $done({}); return; }

    const ckey = "dllm_" + hash(tl + "|" + q);
    const cached = $persistentStore.read(ckey);
    if (cached) {
        try {
            const arr = JSON.parse(cached);
            if (Array.isArray(arr) && arr.length === lines.length) {
                console.log("[DSL] 缓存命中 " + idx.length + " 句");
                respond(arr);
                return;
            }
        } catch (e) {}
    }

    console.log("[DSL] GLM 翻译 " + idx.length + " 句（" + lines.length + " 行）");
    const sys = "你是专业字幕译者。把每条英文翻译成简体中文，口语自然、简短，保持人名的常见中文译法。" +
        "只输出 JSON 对象，key 为编号字符串（如 \"1\"、\"2\"），value 为对应译文，不要输出任何其他内容。";

    const out = lines.slice();
    const work = idx.map(function (i) { return i; });   // 需要翻译的行下标
    const starts = [];
    for (let s = 0; s < work.length; s += CHUNK) starts.push(s);
    const totalChunks = starts.length;
    let remaining = totalChunks;

    function runChunk(start, cb) {
        const slice = work.slice(start, start + CHUNK);
        const numbered = slice.map(function (li, k) { return "[" + (k + 1) + "] " + lines[li]; }).join("\n");
        (function nextModel(mi) {
            if (mi >= MODELS.length) { cb(); return; }
            callLLM(MODELS[mi], sys, numbered, function (obj) {
                if (!obj) { nextModel(mi + 1); return; }
                for (let k = 0; k < slice.length; k++) {
                    const v = obj[String(k + 1)];
                    if (v) out[slice[k]] = String(v).trim();
                }
                cb();
            });
        })(0);
    }

    function next() {
        if (!starts.length) return;
        const start = starts.shift();
        runChunk(start, function () {
            remaining--;
            next();
            if (remaining === 0) done();
        });
    }
    for (let i = 0; i < CONC; i++) next();

    function done() {
        const filled = work.filter(function (li) { return out[li] !== lines[li]; }).length;
        console.log("[DSL] 翻译完成 " + filled + "/" + work.length);
        if (filled >= work.length * 0.9) $persistentStore.write(ckey, JSON.stringify(out));
        respond(out);
    }
}

// 按 DualSubs 命中的端点还原成 Google 的响应格式
function respond(linesOut) {
    const orig = q.split("\n");
    let body;
    if (/\/translate_a\/t/.test(url)) {
        body = JSON.stringify([linesOut.join("\r")]);
    } else if (dj) {
        body = JSON.stringify({
            sentences: linesOut.map(function (t, i) { return { trans: t, orig: orig[i] || "", backend: 10 }; }),
            src: sl,
            confidence: 1,
            ld_result: { srclangs: [sl], srclangs_confidences: [1], extended_srclangs: [sl] }
        });
    } else {
        body = JSON.stringify([
            linesOut.map(function (t, i) { return [t, orig[i] || "", null, null, 10]; }),
            null, sl
        ]);
    }
    $done({
        response: {
            status: 200,
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: body
        }
    });
}

function callLLM(model, sys, user, cb) {
    $httpClient.post({
        url: ZP_URL,
        headers: { "Authorization": "Bearer " + ZP_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
            model: model,
            messages: [{ role: "system", content: sys }, { role: "user", content: user }],
            temperature: 0.2
        }),
        timeout: TIMEOUT
    }, function (err, resp, data) {
        if (err || !resp || resp.status !== 200) {
            console.log("[DSL] " + model + " 失败: " + (err ? err.message || err : (resp && resp.status) || "unknown"));
            cb(null);
            return;
        }
        try {
            const j = JSON.parse(data);
            const txt = j.choices[0].message.content.replace(/```json|```/g, "").trim();
            cb(JSON.parse(txt));
        } catch (e) {
            console.log("[DSL] " + model + " 解析失败: " + e.message);
            cb(null);
        }
    });
}

function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
    return (h >>> 0).toString(36);
}
