/**
 * 凯尔资商城小程序 —— 每日任务（登录 + 点赞 + 评论）
 * 接口：GET + unionId query 鉴权
 */
const UID_KEY = "kaierzi_unionid";
const LAST_DATE_KEY = "kaierzi_last_task_date";
const BASE = "https://api.carez.com.cn/paishanshi";

const SHEQU_IDS = ["650539", "650547"];
const COMMENTS = [
  "很好用，值得推荐！",
  "狗狗很喜欢，回购了～",
  "质量不错，发货也快。",
  "又来签到了，加油！",
];

const HEADERS = {
  "app": "carez",
  "content-type": "application/json",
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.80(0x1800502c) NetType/WIFI Language/zh_CN",
  "Referer": "https://servicewechat.com/wx90a74874b16bb10f/82/page-frame.html",
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const get = (name, path) =>
  new Promise((resolve) => {
    console.log(`[凯尔资] 请求 ${name}: ${path}`);
    $httpClient.get({ url: BASE + path, headers: HEADERS }, (err, resp, data) => {
      if (err) {
        console.log(`[凯尔资] ${name} 请求错误: ${err}`);
        return resolve(`❌ ${name}：${err}`);
      }
      console.log(`[凯尔资] ${name} 响应: ${data}`);
      try {
        const d = JSON.parse(data);
        const ok = d && (d.code === 0 || d.code === 200 || d.success === true || d.status === 0);
        resolve(`${ok ? "✅" : "⚠️"} ${name}：${(d && (d.msg || d.message)) || data}`);
      } catch (e) {
        resolve(`⚠️ ${name}：${data}`);
      }
    });
  });

(async () => {
  try {
    const uid = $persistentStore.read(UID_KEY);
    console.log(`[凯尔资] unionId = ${uid ? uid.substring(0, 12) + "..." : "(空)"}`);
    if (!uid) {
      $notification.post("凯尔资 每日任务", "", "❌ 未找到 unionId，请先打开小程序抓取");
      $done();
      return;
    }
    const today = new Date().toLocaleDateString("zh-CN");
    if ($persistentStore.read(LAST_DATE_KEY) === today) {
      console.log("[凯尔资] 今日已完成，跳过");
      $notification.post("凯尔资 每日任务", "", "☑️ 今日任务已完成，跳过");
      $done();
      return;
    }

    const results = [];
    results.push(await get("每日登录", `/shequ/mine?unionId=${uid}`));
    await new Promise((r) => setTimeout(r, 2000));
    results.push(await get("点赞", `/shequ/agree/commit?shequId=${pick(SHEQU_IDS)}&unionId=${uid}`));
    await new Promise((r) => setTimeout(r, 3000));
    results.push(await get("评论", `/shequ/comment/commit?shequId=${pick(SHEQU_IDS)}&content=${encodeURIComponent(pick(COMMENTS))}&unionId=${uid}`));

    console.log("[凯尔资] 结果汇总:\n" + results.join("\n"));
    $notification.post("凯尔资 每日任务", "", results.join("\n"));
    $persistentStore.write(today, LAST_DATE_KEY);
  } catch (e) {
    console.log(`[凯尔资] 异常: ${e.stack || e}`);
    $notification.post("凯尔资 每日任务", "", `❌ 脚本异常：${e}`);
  }
  $done();
})();
