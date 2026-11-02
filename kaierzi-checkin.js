/**
 * 凯尔资商城小程序 —— 每日任务（登录 + 点赞 + 评论）Loon 定时脚本
 *
 * 前置：先运行 capture 脚本抓取 Token
 * 用法：Loon 定时任务，建议每天 09:00 执行
 *
 * ⚠️ 三个任务的接口 URL / 参数均需按抓包结果填写 TODO 部分。
 */

const TOKEN_KEY = "kaierzi_token";
const LAST_DATE_KEY = "kaierzi_last_task_date";
const token = $persistentStore.read(TOKEN_KEY);

// ========== TODO：按抓包结果填写 ==========
const BASE = "https://api.kaierzi.example.com"; // 实际 API 域名

// 任务1：每日登录
const LOGIN_API = "/user/dailyLogin";

// 任务2：点赞。需要目标内容 id，建议每天随机挑一个商品/帖子
const LIKE_API = "/content/like";
const CONTENT_IDS = []; // TODO: 抓包点赞请求获得内容 id，如 ["12345","12346"]

// 任务3：评论
const COMMENT_API = "/content/comment";
const COMMENT_TEXTS = [
  "很好用，值得推荐！",
  "狗狗很喜欢，回购了～",
  "质量不错，发货也快。",
];
// ==========================================

if (!token) {
  $notification.post("凯尔资 每日任务", "", "❌ 未找到 Token，请先打开小程序抓取");
  $done();
} else {
  const today = new Date().toLocaleDateString("zh-CN");
  if ($persistentStore.read(LAST_DATE_KEY) === today) {
    console.log("今日任务已完成，跳过");
    $done();
  } else {
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) MicroMessenger",
      "Authorization": token,
      "token": token,
    };
    const results = [];

    // 串行执行，避免触发风控
    const post = (path, body) =>
      new Promise((resolve) => {
        $httpClient.post(
          { url: BASE + path, headers, body: JSON.stringify(body || {}) },
          (err, resp, data) => {
            if (err) return resolve(`❌ ${err}`);
            try {
              const d = JSON.parse(data);
              resolve(d && (d.code === 0 || d.success)
                ? `✅ ${path}：${d.msg || "成功"}`
                : `⚠️ ${path}：${d ? d.msg || data : data}`);
            } catch (e) {
              resolve(`⚠️ ${path}：${data}`);
            }
          }
        );
      });

    (async () => {
      // 1. 每日登录
      results.push(await post(LOGIN_API));

      // 2. 点赞（随机一个内容）
      if (CONTENT_IDS.length) {
        const id = CONTENT_IDS[Math.floor(Math.random() * CONTENT_IDS.length)];
        results.push(await post(LIKE_API, { id }));
      } else {
        results.push("⏭️ 点赞：未配置内容 id（TODO）");
      }

      // 3. 评论（随机一条 + 随机内容）
      if (CONTENT_IDS.length) {
        const id = CONTENT_IDS[Math.floor(Math.random() * CONTENT_IDS.length)];
        const text = COMMENT_TEXTS[Math.floor(Math.random() * COMMENT_TEXTS.length)];
        results.push(await post(COMMENT_API, { id, content: text }));
      } else {
        results.push("⏭️ 评论：未配置内容 id（TODO）");
      }

      const allOk = results.every((r) => !r.startsWith("❌") || r.includes("已"));
      if (!allOk) results.forEach((r) => console.log(r));
      $notification.post("凯尔资 每日任务", "", results.join("\n"));
      $persistentStore.write(today, LAST_DATE_KEY);
      $done();
    })();
  }
}
