/**
 * DualSubs · LLM 字幕翻译转发脚本
 *
 * 作用：拦住 DualSubs 发往 Google 翻译的请求，转发给你自己的翻译网关。
 * 支持多个网关候选，按顺序尝试，前一个失败自动回退下一个：
 *   例如 "https://dsl-llm.xxx.workers.dev/translate?t=你的token, http://192.168.31.50:8787/translate"
 *   在家走局域网更快，外出时局域网不可达就自动走云端 Worker。
 *
 * 优先级：持久化键 dsl_gw > 下面的 GW_DEFAULT。
 */

const GW_DEFAULT = "http://192.168.31.50:8787/translate";

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

const q = param("q");
const sl = param("sl") || "auto";
const tl = param("tl") || "zh-CN";
const dj = /[?&]dj=1(&|$)/.test(url);

function tryOne(i) {
    if (i >= GW_LIST.length) {
        console.log("[DSL] 所有网关均不可用，放行原请求");
        $done({});
        return;
    }
    const gw = GW_LIST[i];
    const payload = JSON.stringify({ q: q, sl: sl, tl: tl, dj: dj });
    $httpClient.post(
        { url: gw, headers: { "Content-Type": "application/json" }, body: payload, timeout: 90 },
        function (err, resp, data) {
            const ok = !err && data && String(data).trim().length > 2;
            if (!ok) {
                console.log("[DSL] 网关 " + gw + " 失败(" + (err || "empty") + ")，尝试下一个");
                tryOne(i + 1);
                return;
            }
            $done({
                response: {
                    status: 200,
                    headers: { "Content-Type": "application/json; charset=utf-8" },
                    body: data
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
