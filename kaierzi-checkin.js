/**
 * 凯尔资商城小程序 —— 每日任务：登录 + 20赞 + 10评论
 * 列表接口自动获取帖子id，模拟人工节奏执行
 */
const UID_KEY = "kaierzi_unionid";
const LAST_DATE_KEY = "kaierzi_last_task_date_v2";
const BASE = "https://api.carez.com.cn/paishanshi";

const LIKE_COUNT = 20;   // 目标点赞数
const COMMENT_COUNT = 10; // 目标评论数
const MAX_PAGES = 3;      // 最多翻几页列表

const HEADERS = {
  "app": "carez",
  "content-type": "application/json",
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.80(0x1800502c) NetType/WIFI Language/zh_CN",
  "Referer": "https://servicewechat.com/wx90a74874b16bb10f/82/page-frame.html",
};

// 评论模板：运行时拼接日期/随机尾缀，避免完全重复
const C_TPL = [
  "狗狗真可爱！{s}",
  "好萌啊，收藏了～{s}",
  "养狗人的快乐就是这么简单{s}",
  "照片拍得真好{s}",
  "每天来看帖，治愈{s}",
  "同款狗子，握手！{s}",
  "经验受教了，谢谢分享{s}",
  "能量满满的一天，加油{s}",
];
const rnd = () => Math.random().toString(36).slice(2, 4);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

const get = (path) =>
  new Promise((resolve) => {
    $httpClient.get({ url: BASE + path, headers: HEADERS }, (err, resp, data) => {
      if (err) return resolve({ err: String(err) });
      try { resolve(JSON.parse(data)); } catch (e) { resolve({ raw: data }); }
    });
  });

(async () => {
  try {
    const uid = $persistentStore.read(UID_KEY);
    console.log(`[凯尔资] unionId = ${uid ? uid.slice(0, 12) + "..." : "(空)"}`);
    if (!uid) {
      $notification.post("凯尔资 每日任务", "", "❌ 未找到 unionId，请先打开小程序抓取");
      return $done();
    }
    const today = new Date().toLocaleDateString("zh-CN");
    if ($persistentStore.read(LAST_DATE_KEY) === today) {
      console.log("[凯尔资] 今日已完成，跳过");
      return $done();
    }

    // 1. 每日登录
    await get(`/shequ/mine?unionId=${uid}`);
    await sleep(1500);

    // 2. 拉帖子列表收集 id（优先未赞过的）
    let ids = [];
    for (let p = 1; p <= MAX_PAGES && ids.length < LIKE_COUNT + COMMENT_COUNT; p++) {
      const res = await get(`/shequ/list?key=&curPage=${p}&type=2&unionId=${uid}`);
      const list = (res && res.shequList) || [];
      if (!list.length) break;
      for (const it of list) {
        if (it.id && it.agreed === 0) ids.push(it.id);
        else if (it.id) ids.push(it.id);
      }
      await sleep(randInt(1000, 2000));
    }
    ids = [...new Set(ids)];
    console.log(`[凯尔资] 收集到 ${ids.length} 个帖子id`);
    const likeIds = ids.slice(0, LIKE_COUNT);
    const commentIds = ids.slice(-COMMENT_COUNT); // 评论用靠后的帖子，降低互动雷同
    let okL = 0, okC = 0, fail = [];

    // 3. 点赞 20 次
    for (const id of likeIds) {
      const r = await get(`/shequ/agree/commit?shequId=${id}&unionId=${uid}`);
      if (r && r.result === "1") okL++; else fail.push(`赞${id}:${r.message || r.err || JSON.stringify(r).slice(0, 50)}`);
      await sleep(randInt(3000, 6000));
    }

    // 4. 评论 10 次
    for (const id of commentIds) {
      const text = encodeURIComponent(C_TPL[randInt(0, C_TPL.length - 1)].replace("{s}", rnd()));
      const r = await get(`/shequ/comment/commit?shequId=${id}&content=${text}&unionId=${uid}`);
      if (r && r.result === "1") okC++; else fail.push(`评${id}:${r.message || r.err || JSON.stringify(r).slice(0, 50)}`);
      await sleep(randInt(5000, 10000));
    }

    const msg = `登录 ✅｜点赞 ${okL}/${LIKE_COUNT}｜评论 ${okC}/${COMMENT_COUNT}` + (fail.length ? `\n失败：${fail.slice(0, 3).join("；")}` : "");
    console.log("[凯尔资] " + msg);
    $notification.post("凯尔资 每日任务", "", msg);
    if (okL >= LIKE_COUNT - 2 && okC >= COMMENT_COUNT - 1) {
      $persistentStore.write(today, LAST_DATE_KEY);
    }
  } catch (e) {
    console.log(`[凯尔资] 异常: ${e.stack || e}`);
    $notification.post("凯尔资 每日任务", "", `❌ 脚本异常：${e}`);
  }
  $done();
})();
