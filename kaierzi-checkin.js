/**
 * 凯尔资商城小程序 —— 每日任务（登录 + 点赞 + 评论）Loon 定时脚本
 * 接口均为 GET + query 鉴权（unionId），由 capture 脚本自动存储
 */
const UID_KEY = "kaierzi_unionid";
const LAST_DATE_KEY = "kaierzi_last_task_date";
const BASE = "https://api.carez.com.cn/paishanshi";

// 点赞/评论的目标内容 id（社区帖子），可自行增删
const SHEQU_IDS = ["650539", "650547"];
// 评论文案池（随机取一条）
const COMMENTS = [
  "很好用，值得推荐！",
  "狗狗很喜欢，回购了～",
  "质量不错，发货也快。",
  "又来签到了，加油！",
];

const uid = $persistentStore.read(UID_KEY);
if (!uid) {
  $notification.post("凯尔资 每日任务", "", "❌ 未找到 unionId，请先打开小程序抓取");
  $done();
} else {
  const today = new Date().toLocaleDateString("zh-CN");
  if ($persistentStore.read(LAST_DATE_KEY) === today) {
    console.log("今日任务已完成，跳过");
    $done();
  } else {
    const headers = {
      "app": "carez",
      "content-type": "application/json",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.80(0x1800502c) NetType/WIFI Language/zh_CN",
      "Referer": "https://servicewechat.com/wx90a74874b16bb10f/82/page-frame.html",
    };
    const results = [];
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

    const get = (name, path) =>
      new Promise((resolve) => {
        $httpClient.get({ url: BASE + path, headers }, (err, resp, data) => {
          if (err) return resolve(`❌ ${name}：${err}`);
          try {
            const d = JSON.parse(data);
            // 常见成功结构：code 0 / 200 / success true，按实际响应微调
            const ok = d && (d.code === 0 || d.code === 200 || d.success === true || d.status === 0);
            resolve(`${ok ? "✅" : "⚠️"} ${name}：${(d && (d.msg || d.message)) || data}`);
          } catch (e) {
            resolve(`⚠️ ${name}：${data}`);
          }
        });
      });

    (async () => {
      // 1. 每日登录（访问个人中心接口触发服务端活跃记录）
      results.push(await get("每日登录", `/shequ/mine?unionId=${uid}`));
      await new Promise((r) => setTimeout(r, 2000));

      // 2. 点赞（随机一个帖子）
      const sid1 = pick(SHEQU_IDS);
      results.push(await get("点赞", `/shequ/agree/commit?shequId=${sid1}&unionId=${uid}`));
      await new Promise((r) => setTimeout(r, 3000));

      // 3. 评论（随机一个帖子 + 随机文案）
      const sid2 = pick(SHEQU_IDS);
      const text = encodeURIComponent(pick(COMMENTS));
      results.push(await get("评论", `/shequ/comment/commit?shequId=${sid2}&content=${text}&unionId=${uid}`));

      $notification.post("凯尔资 每日任务", "", results.join("\n"));
      $persistentStore.write(today, LAST_DATE_KEY);
      $done();
    })();
  }
}
