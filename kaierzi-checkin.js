/**
 * 凯尔资商城小程序 —— 每日任务 v6（多账号）
 * 每账号：登录 + 20赞 + 10评论
 *
 * v6 修复（针对「进度显示 0 / 定时点每个都完整重跑」）：
 *  1) 进度改按「实际发出的请求数」计数，不再依赖返回体 result:"1" 判定成功。
 *     实测该接口返回体不可靠：裸请求会回 result:1 但服务端可能不记账，
 *     带登录态的真实返回又未必是 result:1 —— 用它计数会永远停在 0，
 *     导致 doneOf() 永不成立、每个定时点都完整重跑。
 *     只要请求非网络失败地发出去了，就计入进度；返回体仅写日志供诊断。
 *  2) 进度能正常达标 → 补跑点静默跳过；正常情况下一天只跑一轮、只弹 1 条通知。
 *  3) 定时点 5 → 2（10:05 主跑 + 11:05 补跑），仅网络异常留缺额时才真正补跑。
 *  4) 保留：分项进度补做、单请求超时重试、连续网络异常熔断、已尝试帖子换帖。
 *     注意：完成依据是「发够 20赞+10评」而非「某个返回说成功」，
 *     因此不会回到 v4 之前『假成功就整天跳过』的老问题。
 */
const UIDS_KEY = "kaierzi_unionids";
const PROGRESS_KEY = "kaierzi_progress_v6";          // { "日期": { uid: {like, comment} } } 记录已发出请求数
const TRIED_KEY = "kaierzi_tried_v5";                // { "日期": { uid: [shequId...] } } 沿用换帖记录
const LEGACY_DATE_KEY = "kaierzi_last_task_date_v3"; // 旧版标记：只清理，绝不信任
const DEFAULT_UIDS = [
  "o0wYP57V8XFMhUdP6aOv34WaJiIs",
  "o0wYP5xGdH6GUcyyWuYJVl89PlXY",
];
const BASE = "https://api.carez.com.cn/paishanshi";

const LIKE_COUNT = 20;
const COMMENT_COUNT = 10;
const MAX_PAGES = 8;
const REQ_TIMEOUT = 12000;
const MAX_RETRY = 1;
const NET_FAIL_ABORT = 3;

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
const isStdResp = (r) => r && (r.result === "1" || r.result === 1); // 仅用于日志标注，不再用于计数

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
async function get(path) {
  let last;
  for (let k = 0; k <= MAX_RETRY; k++) {
    last = await requestOnce(path);
    if (!last.netFail) return last;
    if (k < MAX_RETRY) await sleep(2000);
  }
  return last;
}

function loadObj(key, date) {
  try {
    const all = JSON.parse($persistentStore.read(key) || "{}");
    return all[date] || {};
  } catch (e) { return {}; }
}
function saveObj(key, date, obj) {
  $persistentStore.write(JSON.stringify({ [date]: obj }), key);
}
function orderByUntried(pool, triedArr) {
  const t = new Set(triedArr || []);
  return [...pool.filter((id) => !t.has(id)), ...pool.filter((id) => t.has(id))];
}
function markTried(tried, uid, id) {
  if (!tried[uid]) tried[uid] = [];
  if (!tried[uid].includes(id)) tried[uid].push(id);
  if (tried[uid].length > 300) tried[uid] = tried[uid].slice(-300);
}

(async () => {
  try {
    const date = new Date().toLocaleDateString("zh-CN");

    if ($persistentStore.read(LEGACY_DATE_KEY)) {
      $persistentStore.write("", LEGACY_DATE_KEY);
      console.log("[凯尔资] 已清空旧版完成标记");
    }

    let rawUids = $persistentStore.read(UIDS_KEY) || "";
    const legacy = $persistentStore.read("kaierzi_unionid");
    if (legacy && !rawUids.includes(legacy)) {
      rawUids = rawUids ? rawUids + "," + legacy : legacy;
      $persistentStore.write(rawUids, UIDS_KEY);
    }
    const uids = [...new Set([...DEFAULT_UIDS, ...rawUids.split(",").filter(Boolean)])];
    if (!uids.length) {
      $notification.post("凯尔资 每日任务", "", "❌ 未找到 unionId，请先用各微信号打开小程序抓取");
      return $done();
    }

    const prog = loadObj(PROGRESS_KEY, date);
    const tried = loadObj(TRIED_KEY, date);
    // 完成 = 该账号本轮已发够 20赞 + 10评（按实际发出请求数，不看返回体）
    const doneOf = (uid) => {
      const p = prog[uid] || { like: 0, comment: 0 };
      return p.like >= LIKE_COUNT && p.comment >= COMMENT_COUNT;
    };
    if (uids.every(doneOf)) {
      console.log("[凯尔资] 今日已跑完一轮，跳过（补跑点静默）");
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
        lines.push(`账号${i + 1}：已跑完 赞${p.like} 评${p.comment}`);
        continue;
      }
      console.log(`[凯尔资] ===== 账号${i + 1} 补做 已发赞${p.like}/${LIKE_COUNT} 评${p.comment}/${COMMENT_COUNT} =====`);

      await get(`/shequ/mine?unionId=${uid}`);
      await sleep(1200);

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

      const likePool = orderByUntried([...new Set([...fresh, ...all])], tried[uid]);
      let commentPool = [...new Set([...all].reverse())]
        .filter((id) => !fresh.slice(0, LIKE_COUNT).includes(id));
      if (commentPool.length < COMMENT_COUNT) commentPool = [...new Set([...commentPool, ...all])];
      commentPool = orderByUntried(commentPool, tried[uid]);

      let netFails = 0;
      // ---- 点赞：只补缺额；请求发出即计数 ----
      for (const id of likePool) {
        if (p.like >= LIKE_COUNT) break;
        const r = await get(`/shequ/agree/commit?shequId=${id}&unionId=${uid}`);
        markTried(tried, uid, id);
        if (r && r.netFail) {
          netFails++;
          if (netFails >= NET_FAIL_ABORT) { aborted = true; break; }
          await sleep(1500);
          continue;
        }
        netFails = 0;
        p.like++; totalAdded++;
        saveObj(PROGRESS_KEY, date, prog);
        saveObj(TRIED_KEY, date, tried);
        if (!isStdResp(r)) {
          console.log(`[凯尔资] 点赞返回非标准(已计入) id=${id} resp=${JSON.stringify(r).slice(0, 160)}`);
        }
        await sleep(randInt(3000, 6000));
      }

      // ---- 评论：只补缺额；请求发出即计数 ----
      if (!aborted) {
        netFails = 0;
        for (const id of commentPool) {
          if (p.comment >= COMMENT_COUNT) break;
          const text = encodeURIComponent(
            pick(C_TPL).replace("{s}", Math.random().toString(36).slice(2, 4))
          );
          const r = await get(`/shequ/comment/commit?shequId=${id}&content=${text}&unionId=${uid}`);
          markTried(tried, uid, id);
          if (r && r.netFail) {
            netFails++;
            if (netFails >= NET_FAIL_ABORT) { aborted = true; break; }
            await sleep(1500);
            continue;
          }
          netFails = 0;
          p.comment++; totalAdded++;
          saveObj(PROGRESS_KEY, date, prog);
          saveObj(TRIED_KEY, date, tried);
          if (!isStdResp(r)) {
            console.log(`[凯尔资] 评论返回非标准(已计入) id=${id} resp=${JSON.stringify(r).slice(0, 160)}`);
          }
          await sleep(randInt(5000, 10000));
        }
      }

      saveObj(PROGRESS_KEY, date, prog);
      saveObj(TRIED_KEY, date, tried);
      lines.push(
        `账号${i + 1}：已发 赞${p.like}/${LIKE_COUNT} 评${p.comment}/${COMMENT_COUNT}` +
        `（本次 +${p.like - startL}赞 +${p.comment - startC}评）`
      );
      if (aborted) break;
      if (uids.length > 1) await sleep(randInt(5000, 10000));
    }

    const nowDone = uids.every(doneOf);
    if (nowDone && totalAdded === 0) return $done(); // 补跑点：已完成，静默

    const sub = aborted
      ? "⚠️ 网络异常，已存进度，稍后自动补跑"
      : nowDone
        ? "✅ 今日已跑完一轮（补跑点将静默跳过）"
        : "⚠️ 部分完成，稍后自动补做";
    $notification.post(
      "凯尔资 每日任务",
      sub,
      lines.join("\n") + "\n进度=已发出请求数；实际积分以App内为准"
    );
  } catch (e) {
    console.log(`[凯尔资] 异常: ${e.stack || e}`);
    $notification.post("凯尔资 每日任务", "", `❌ 脚本异常：${e}`);
  }
  $done();
})();
