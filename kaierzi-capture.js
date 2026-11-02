/**
 * 凯尔资商城小程序 —— 凭证获取脚本（Loon http-request 重写）
 * 鉴权方式：URL query 中的 unionId（部分接口可能还带 token 请求头）
 */
const HOST = "api.carez.com.cn";
const UID_KEY = "kaierzi_unionid";
const TOKEN_KEY = "kaierzi_token";

if ($request && $request.url.indexOf(HOST) !== -1) {
  const h = $request.headers;
  const token = h["Authorization"] || h["authorization"] || h["token"] || h["Token"] || h["Cookie"] || h["cookie"] || "";
  if (token) {
    const oldT = $persistentStore.read(TOKEN_KEY);
    if (oldT !== token) {
      $persistentStore.write(token, TOKEN_KEY);
      $notification.post("凯尔资商城", "", oldT ? "Token 已更新 ✅" : "Token 获取成功 ✅");
    }
  }
  const m = $request.url.match(/unionId=([^&]+)/);
  if (m && m[1]) {
    const uid = decodeURIComponent(m[1]);
    const oldU = $persistentStore.read(UID_KEY);
    if (oldU !== uid) {
      $persistentStore.write(uid, UID_KEY);
      $notification.post("凯尔资商城", "", oldU ? "unionId 已更新 ✅" : "unionId 获取成功 ✅\n" + uid.substring(0, 12) + "...");
    }
  }
}
$done({});
