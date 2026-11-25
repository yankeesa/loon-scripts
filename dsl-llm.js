/**
 * DualSubs · LLM 字幕翻译转发脚本
 * 作用：拦住 DualSubs 发往 Google 翻译的请求，转给你局域网里的翻译网关。
 * 网关地址优先读持久化键 dsl_gw，否则用下面的默认值。
 */

const GW_DEFAULT = "http://192.168.31.50:8787/translate";
const GW = ($persistentStore.read("dsl_gw") || GW_DEFAULT).replace(/\/+$/, "");

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

if (!q) {
    $done({});
} else {
    const payload = JSON.stringify({ q: q, sl: sl, tl: tl, dj: dj });
    $httpClient.post(
        {
            url: GW,
            headers: { "Content-Type": "application/json" },
            body: payload,
            timeout: 60
        },
        function (err, resp, data) {
            if (err || !data) {
                console.log("[DSL] 网关未响应，放行原请求: " + (err || "empty body"));
                $done({});
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
