/**
 * 凯尔资商城小程序 —— 每日任务（多账号版）
 * 每个账号：登录 + 20赞 + 10评论
 */
const UIDS_KEY = "kaierzi_unionids";
const LAST_DATE_KEY = "kaierzi_last_task_date_v3";
// 预置账号 unionId（新号也可通过打开小程序自动追加）
const DEFAULT_UIDS = [
  "o0wYP57V8XFMhUdP6aOv34WaJiIs",
  "o0wYP5xGdH6GUcyyWuYJVl89PlXY",
];
const BASE = "https://api.carez.com.cn/paishanshi";

const LIKE_COUNT = 20;
const COMMENT_COUNT = 10;
const MAX_PAGES = 3;

const HEADERS = {
  "app": "carez",
  "content-type": "application/json",
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.80(0x1800502c) NetType/WIFI Language/zh_CN",
  "Referer": "https://servicewechat.com/wx90a74874b16bb10f/82/page-frame.html",
};

const C_TPL = [
  "狗狗真可爱！{s}", "好萌啊，收藏了～{s}", "养狗人的快乐就是这么简单{s}",
  "照片拍得真好{s}", "每天来看帖，治愈{s}", "同款狗子，握手！{s}",
  "经验受教了，谢谢分享{s}", "能量满满的一天，加油{s}", "来学习养宠经验{s}", "太治愈了这组照片{s}",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const pick = (arr) => arr[randInt(0, arr.length - 1)];

const get = (path) =>
  new Promise((resolve) => {
    $httpClient.get({ url: BASE + path, headers: HEADERS }, (err, resp, data) => {
      if (err) return resolve({ err: String(err) });
      try { resolve(JSON.parse(data)); } catch (e) { resolve({ raw: data }); }
    });
  });

(async () => {
  try {
    let raw = $persistentStore.read(UIDS_KEY) || "";
    // 兼容迁移：旧版单账号键 -> 新版多账号键
    const legacy = $persistentStore.read("kaierzi_unionid");
    if (legacy && !raw.includes(legacy)) {
      raw = raw ? raw + "," + legacy : legacy;
      $persistentStore.write(raw, UIDS_KEY);
      console.log("[凯尔资] 已从旧键迁移 unionId");
    }
    const uids = [...new Set([...DEFAULT_UIDS, ...raw.split(",").filter(Boolean)])];
    console.log(`[凯尔资] 共 ${uids.length} 个账号`);
    if (!uids.length) {
      $notification.post("凯尔资 每日任务", "", "❌ 未找到 unionId，请先用各微信号打开小程序抓取");
      return $done();
    }
    const today = new Date().toLocaleDateString("zh-CN");
    if ($persistentStore.read(LAST_DATE_KEY) === today) {
      console.log("[凯尔资] 今日已完成，跳过");
      return $done();
    }

    const summary = [];
    for (let i = 0; i < uids.length; i++) {
      const uid = uids[i];
      console.log(`[凯尔资] ===== 账号${i + 1} 开始 =====`);

      // 登录
      await get(`/shequ/mine?unionId=${uid}`);
      await sleep(1500);

      // 收集帖子id（每个账号都重新拉一次，列表可能不同）
      let ids = [];
      for (let p = 1; p <= MAX_PAGES && ids.length < LIKE_COUNT + COMMENT_COUNT; p++) {
        const res = await get(`/shequ/list?key=&curPage=${p}&type=2&unionId=${uid}`);
        const list = (res && res.shequList) || [];
        if (!list.length) break;
        list.forEach((it) => { if (it.id && it.agreed === 0) ids.push(it.id); });
        await sleep(randInt(1000, 2000));
      }
      ids = [...new Set(ids)];
      console.log(`[凯尔资] 账号${i + 1} 收集到 ${ids.length} 个帖子`);

      const likeIds = ids.slice(0, LIKE_COUNT);
      const commentIds = ids.slice(-COMMENT_COUNT).reverse(); // 与点赞错开
      let okL = 0, okC = 0; const fail = [];

      for (const id of likeIds) {
        const r = await get(`/shequ/agree/commit?shequId=${id}&unionId=${uid}`);
        if (r && r.result === "1") okL++; else fail.push(`赞${id}`);
        await sleep(randInt(3000, 6000));
      }
      for (const id of commentIds) {
        const text = encodeURIComponent(C_TPL[randInt(0, C_TPL.length - 1)].replace("{s}", Math.random().toString(36).slice(2, 4)));
        const r = await get(`/shequ/comment/commit?shequId=${id}&content=${text}&unionId=${uid}`);
        if (r && r.result === "1") okC++; else fail.push(`评${id}`);
        await sleep(randInt(5000, 10000));
      }
      summary.push(`账号${i + 1}：登录✅ 赞${okL}/${LIKE_COUNT} 评${okC}/${COMMENT_COUNT}` + (fail.length ? `（失败${fail.length}）` : ""));
      if (uids.length > 1) await sleep(randInt(5000, 10000)); // 账号间间隔
    }

    $notification.post("凯尔资 每日任务", "", summary.join("\n"));
    if (summary.every((s) => s.includes(`赞${LIKE_COUNT}`) && s.includes(`评${COMMENT_COUNT}`))) {
      $persistentStore.write(today, LAST_DATE_KEY);
    }
  } catch (e) {
    console.log(`[凯尔资] 异常: ${e.stack || e}`);
    $notification.post("凯尔资 每日任务", "", `❌ 脚本异常：${e}`);
  }
  $done();
})();
