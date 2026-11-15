/**
 * 凯尔资商城小程序 —— 每日任务 v4（多账号）
 * 每账号：登录 + 20赞 + 10评论
 *
 * v4 修复：
 *  1) 进度按「日期+账号+赞/评」分项持久化，每次运行只补做缺额
 *     → 不会再出现"只有评论没点赞"且当天无法补做
 *  2) 单个请求网络失败自动重试；连续网络异常熔断并保存进度
 *  3) 插件配置多个 cron 时间点，任一时刻网络不畅由后续任务自动补跑
 */
const UIDS_KEY = "kaierzi_unionids";
const PROGRESS_KEY = "kaierzi_progress_v4";       // { "日期": { uid: {like, comment} } }
const LEGACY_DATE_KEY = "kaierzi_last_task_date_v3"; // 兼容旧版"今日完成"标记
const DEFAULT_UIDS = [
  "o0wYP57V8XFMhUdP6aOv34WaJiIs",
  "o0wYP5xGdH6GUcyyWuYJVl89PlXY",
];
const BASE = "https://api.carez.com.cn/paishanshi";

const LIKE_COUNT = 20;
const COMMENT_COUNT = 10;
const MAX_PAGES = 5;
const REQ_TIMEOUT = 12000;   // 单请求超时(ms)
const MAX_RETRY = 1;         // 网络失败重试次数（共 2 次尝试）
const NET_FAIL_ABORT = 3;    // 连续网络异常熔断阈值

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
const isSuccess = (r) => r && (r.result === "1" || r.result === 1);

// 单次请求（带超时保护，区分"网络失败"与"业务失败"）
function requestOnce(path) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => finish({ err: "timeout", netFail: true }), REQ_TIMEOUT);
    try {
      $httpClient.get({ url: BASE + path, headers: HEADERS }, (err, resp, data) => {
        clearTimeout(timer);
        if (err) return finish({ err: String(err), netFail: true });
        try { finish(JSON.parse(data)); } catch (e) { finish({ raw: data }); }
      });
    } catch (e) {
      clearTimeout(timer);
      finish({ err: String(e), netFail: true });
    }
  });
}

// 网络失败才重试；业务失败（如已赞过）不重试，直接换下一个帖子
async function get(path) {
  let last;
  for (let k = 0; k <= MAX_RETRY; k++) {
    last = await requestOnce(path);
    if (!last.netFail) return last;
    if (k < MAX_RETRY) await sleep(2000);
  }
  return last;
}

function loadProgress(date) {
  try {
    const all = JSON.parse($persistentStore.read(PROGRESS_KEY) || "{}");
    return all[date] || {};
  } catch (e) { return {}; }
}
function saveProgress(date, prog) {
  // 只保留当天，日期一变自动重置
  $persistentStore.write(JSON.stringify({ [date]: prog }), PROGRESS_KEY);
}

(async () => {
  try {
    const date = new Date().toLocaleDateString("zh-CN");

    let rawUids = $persistentStore.read(UIDS_KEY) || "";
    const legacy = $persistentStore.read("kaierzi_unionid");
    if (legacy && !rawUids.includes(legacy)) {
      rawUids = rawUids ? rawUids + "," + legacy : legacy;
      $persistentStore.write(rawUids, UIDS_KEY);
      console.log("[凯尔资] 已从旧键迁移 unionId");
    }
    const uids = [...new Set([...DEFAULT_UIDS, ...rawUids.split(",").filter(Boolean)])];
    if (!uids.length) {
      $notification.post("凯尔资 每日任务", "", "❌ 未找到 unionId，请先用各微信号打开小程序抓取");
      return $done();
    }

    // 兼容：旧版脚本今天已判定完成
    if ($persistentStore.read(LEGACY_DATE_KEY) === date) {
      console.log("[凯尔资] 旧标记显示今日已完成，跳过");
      return $done();
    }

    const prog = loadProgress(date);
    const doneOf = (uid) => {
      const p = prog[uid] || { like: 0, comment: 0 };
      return p.like >= LIKE_COUNT && p.comment >= COMMENT_COUNT;
    };
    if (uids.every(doneOf)) {
      console.log("[凯尔资] 今日任务已完成，跳过（补跑点静默）");
      return $done();
    }

    const lines = [];
    let aborted = false;
    let totalAdded = 0;

    for (let i = 0; i < uids.length; i++) {
      const uid = uids[i];
      if (!prog[uid]) prog[uid] = { like: 0, comment: 0 };
      const p = prog[uid];
      const startL = p.like, startC = p.comment;

      if (doneOf(uid)) {
        lines.push(`账号${i + 1}：已完成 赞${p.like} 评${p.comment}`);
        continue;
      }
      console.log(`[凯尔资] ===== 账号${i + 1} 补做 赞${p.like}/${LIKE_COUNT} 评${p.comment}/${COMMENT_COUNT} =====`);

      // 登录
      await get(`/shequ/mine?unionId=${uid}`);
      await sleep(1200);

      // 收集帖子 id：agreed 字段不可靠（缓存/串号），全部收集，未赞标记排前面优先尝试
      let fresh = [], all = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await get(`/shequ/list?key=&curPage=${page}&type=2&unionId=${uid}`);
        const list = (res && res.shequList) || [];
        if (!list.length) break;
        list.forEach((it) => {
          if (!it.id) return;
          all.push(it.id);
          if (it.agreed === 0) fresh.push(it.id);
        });
        await sleep(randInt(800, 1600));
      }
      all = [...new Set(all)];
      fresh = [...new Set(fresh)];
      if (!all.length) {
        lines.push(`账号${i + 1}：⚠️ 帖子列表为空（网络异常），等待补跑`);
        continue;
      }

      const likePool = [...new Set([...fresh, ...all])];
      let commentPool = [...new Set([...all].reverse())]
        .filter((id) => !fresh.slice(0, LIKE_COUNT).includes(id));
      if (commentPool.length < COMMENT_COUNT) {
        commentPool = [...new Set([...commentPool, ...all])];
      }

      let netFails = 0;
      // ---- 点赞（只补缺额）----
      for (const id of likePool) {
        if (p.like >= LIKE_COUNT) break;
        const r = await get(`/shequ/agree/commit?shequId=${id}&unionId=${uid}`);
        if (r && r.netFail) {
          netFails++;
          if (netFails >= NET_FAIL_ABORT) { aborted = true; break; }
          await sleep(1500);
          continue;
        }
        netFails = 0;
        if (isSuccess(r)) {
          p.like++; totalAdded++;
          saveProgress(date, prog); // 即时落盘，防止脚本被超时中断丢进度
        }
        await sleep(randInt(3000, 6000));
      }

      // ---- 评论（只补缺额；未被熔断才执行）----
      if (!aborted) {
        netFails = 0;
        for (const id of commentPool) {
          if (p.comment >= COMMENT_COUNT) break;
          const text = encodeURIComponent(
            pick(C_TPL).replace("{s}", Math.random().toString(36).slice(2, 4))
          );
          const r = await get(`/shequ/comment/commit?shequId=${id}&content=${text}&unionId=${uid}`);
          if (r && r.netFail) {
            netFails++;
            if (netFails >= NET_FAIL_ABORT) { aborted = true; break; }
            await sleep(1500);
            continue;
          }
          netFails = 0;
          if (isSuccess(r)) {
            p.comment++; totalAdded++;
            saveProgress(date, prog);
          }
          await sleep(randInt(5000, 10000));
        }
      }

      saveProgress(date, prog);
      lines.push(
        `账号${i + 1}：赞${p.like}/${LIKE_COUNT} 评${p.comment}/${COMMENT_COUNT}` +
        `（本次 +${p.like - startL}赞 +${p.comment - startC}评）`
      );
      if (aborted) break;
      if (uids.length > 1) await sleep(randInt(5000, 10000));
    }

    const nowDone = uids.every(doneOf);
    if (nowDone) {
      $persistentStore.write(date, LEGACY_DATE_KEY); // 兼容回退到旧版
    }
    if (nowDone && totalAdded === 0) return $done(); // 已完成且无增量：静默

    const sub = aborted
      ? "⚠️ 网络异常，已存进度，稍后自动补跑"
      : nowDone
        ? "✅ 今日任务已完成（含补做）"
        : "⚠️ 部分完成，稍后自动补做";
    $notification.post("凯尔资 每日任务", sub, lines.join("\n"));
  } catch (e) {
    console.log(`[凯尔资] 异常: ${e.stack || e}`);
    $notification.post("凯尔资 每日任务", "", `❌ 脚本异常：${e}`);
  }
  $done();
})();
