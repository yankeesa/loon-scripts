/**
 * DualSubs · LLM 字幕翻译转发脚本
 *
 * 作用：拦住 DualSubs 发往 Google 翻译的请求，转发给你自己的翻译网关。
 * 支持多个网关候选，按顺序尝试，前一个失败自动回退下一个：
 *   云端 Worker 优先（外出可用），局域网网关兜底（在家更快）。
 *
 * 优先级：持久化键 dsl_gw > 下面的 GW_DEFAULT。
 */

const GW_DEFAULT =
    "https://dsl-llm.yangke19990916.workers.dev/translate?t=YOUR_WORKER_TOKEN" +
    ", http://192.168.31.50:8787/translate";

const GW_LIST = ($persistentStore.read("dsl_gw") || GW_DEFAULT)
    .split(",")
    .map(function (s) { return s.trim().replace(/\/+$/, ""); })
    .filter(function (s) { return s.length > 0; });

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

// q 可能在 URL 上，也可能在 POST body 里（不同 DualSubs 版本两种都会用）
function fromBody(name) {
    const body = typeof $request !== "undefined" && $request.body ? $request.body : "";
    if (!body) return "";
    // 先按表单解析
    try {
        const m = body.match(new RegExp("(?:^|&)" + name + "=([^&]*)"));
        if (m) return decodeURIComponent(m[1].replace(/\+/g, " "));
    } catch (e) {}
    // 再按 JSON 解析
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

// 只有「真拿到译文」才算成功；网关报错、空体、非 200 都回退下一个候选
function looksOk(resp, data) {
    if (!data) return false;
    if (resp && resp.status && resp.status !== 200) return false;
    let obj = null;
    try {
        obj = JSON.parse(data);
    } catch (e) {
        return false;
    }
    if (obj && obj.error) return false;
    return true;
}

function tryOne(i) {
    if (i >= GW_LIST.length) {
        console.log("[DSL] 所有网关均不可用，放行原请求");
        $done({});
        return;
    }
    const gw = GW_LIST[i];
    // 统一要 dj=1 格式（含原文），本地按端点再改造成 DualSubs 期望的样子
    const payload = JSON.stringify({ q: q, sl: sl, tl: tl, dj: true });
    $httpClient.post(
        { url: gw, headers: { "Content-Type": "application/json" }, body: payload, timeout: 90 },
        function (err, resp, data) {
            if (err || !looksOk(resp, data)) {
                console.log("[DSL] 网关 " + gw + " 不可用(" + (err || (resp && resp.status) || "bad body") + ")，尝试下一个");
                tryOne(i + 1);
                return;
            }
            // DualSubs 随机使用两种 Google 端点，期望的响应格式不同：
            //   /translate_a/t (dict-chrome-ex) → ["译文1\r译文2\r..."]
            //   /translate_a/single?...dj=1     → { sentences, src, ... }
            //   /translate_a/single (无 dj)     → [[译文,原文,...], null, src]
            let body = data;
            try {
                const obj = JSON.parse(data);
                const sents = (obj && obj.sentences) || [];
                const trans = sents.map(function (s) { return s.trans; });
                if (/\/translate_a\/t/.test(url)) {
                    body = JSON.stringify([trans.join("\r")]);
                } else if (dj) {
                    body = JSON.stringify({
                        sentences: sents,
                        src: obj.src || sl,
                        confidence: 1,
                        ld_result: { srclangs: [sl], srclangs_confidences: [1], extended_srclangs: [sl] }
                    });
                } else {
                    body = JSON.stringify([
                        sents.map(function (s) { return [s.trans, s.orig, null, null, 10]; }),
                        null, sl
                    ]);
                }
            } catch (e) {
                console.log("[DSL] 响应构造失败，透传原始数据");
            }
            $done({
                response: {
                    status: 200,
                    headers: { "Content-Type": "application/json; charset=utf-8" },
                    body: body
                }
            });
        }
    );
}

if (!q) {
    $done({});
} else {
    tryOne(0);
}
