/**
 * 凯尔资小程序 —— 凭证获取（多账号版）
 * 自动累积存储多个 unionId（去重），每个微信号打开小程序即抓取
 */
const HOST = "api.carez.com.cn";
const UIDS_KEY = "kaierzi_unionids";
const TOKEN_KEY = "kaierzi_token";

if ($request && $request.url.indexOf(HOST) !== -1) {
  const m = $request.url.match(/unionId=([^&]+)/);
  if (m && m[1]) {
    const uid = decodeURIComponent(m[1]);
    const old = $persistentStore.read(UIDS_KEY) || "";
    const list = old ? old.split(",").filter(Boolean) : [];
    if (!list.includes(uid)) {
      list.push(uid);
      $persistentStore.write(list.join(","), UIDS_KEY);
      $notification.post("凯尔资商城", "", `账号${list.length} unionId 获取成功 ✅\n当前共 ${list.length} 个账号`);
    }
  }
  const h = $request.headers;
  const token = h["Authorization"] || h["authorization"] || h["token"] || h["Token"] || h["Cookie"] || h["cookie"] || "";
  if (token) $persistentStore.write(token, TOKEN_KEY);
}
$done({});
