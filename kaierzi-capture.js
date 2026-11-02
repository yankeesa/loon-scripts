/**
 * 凯尔资商城小程序 —— Token 获取脚本（Loon http-request 重写）
 *
 * 用法：启用插件后打开「凯尔资商城」小程序，进入个人中心/任务页面，
 *       脚本自动捕获登录凭证（token/cookie）并持久化存储。
 *
 * ⚠️ 先用 Loon 请求日志确认实际 API 域名与 token 字段，再改下方 HOST。
 *    微信小程序登录态常见两种：
 *    1. 请求头 Authorization / token
 *    2. Cookie（如 SESSION=xxx）
 */

const HOST = "api.kaierzi.example.com"; // TODO: 改为实际抓到的 API 域名
const TOKEN_KEY = "kaierzi_token";

if ($request && $request.url.indexOf(HOST) !== -1) {
  const h = $request.headers;
  const token =
    h["Authorization"] || h["authorization"] ||
    h["token"] || h["Token"] ||
    h["Cookie"] || h["cookie"] || "";

  if (token) {
    const old = $persistentStore.read(TOKEN_KEY);
    if (old !== token) {
      $persistentStore.write(token, TOKEN_KEY);
      $notification.post("凯尔资商城", "", old ? "Token 已更新 ✅" : "Token 获取成功 ✅");
    }
  }
}
$done({});
