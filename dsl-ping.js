/**
 * dsl-ping.js — 拦截探针：仅弹通知验证链路，不修改任何内容
 */
$notification.post("字幕链路测试", "拦截成功", "已捕获 webvtt 请求：" + ($request.url || "").slice(-60));
console.log("[PING] 拦截到 " + $request.url);
$done({});
