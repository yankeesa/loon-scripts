/**
 * 凯尔资商城小程序 —— 每日任务 v7（多账号）
 * 每账号：登录 + 点赞(上限20) + 评论(上限10)
 *
 * v7 根治「点赞积分一直是 0」（实证结论）：
 *   实测 /shequ/agree/commit 是【切换(toggle)】语义：
 *     对 agreed=0 的帖子点 1 次 -> agreed=1, agreeCount+1（真赞上）
 *     再点第 2 次            -> agreed=0, agreeCount-1（取消赞）
 *   且无论生效/取消都返回 {"result":"1"}，脚本无从分辨。
 *   旧版有三处会重复点同一帖：候选池混入已赞帖、网络超时自动重发、补跑/手动重跑，
 *   于是赞被点上去又取消，净积分 0 —— 这就是「评论成功、点赞失败」的真正原因。
 *
 * v7 三条铁律：
 *   1) 点赞池【只】收 agreed===0 的未赞帖，绝不拿已赞帖凑数（不够就如实少点）
 *   2) 点赞请求【绝不重发】：超时/网络失败直接换下一个帖子（重发可能把已生效的赞取消）
 *   3) 每个帖子本轮只发一次；补跑时重新拉列表，之前点过的已 agreed=1 自动排除，
 *      只会补点新的未赞帖，不会取消旧赞
 *   评论是新增内容、无 toggle 语义，保持可重试。
 *
 * 另：本套接口靠 URL 里的 unionId 鉴权，请求头无 token；
 *     进度按「真实发出的首次点赞/评论请求数」计，与积分口径一致。
 */
const UIDS_KEY = "kaierzi_unionids";
const PROGRESS_KEY = "kaierzi_progress_v7";   // { 日期: { uid: {like, comment} } } 已发出的有效请求数
const TRIED_KEY = "kaierzi_tried_v7";         // { 日期: { uid: [shequId...] } } 换帖记录
const ROUND_KEY = "kaierzi_round_v7";         // { 日期: { uid: true } } 本账号已完整跑完一轮
const LEGACY_DATE_KEY = "kaierzi_last_task_date_v3";
const DEFAULT_UIDS = [
  "o0wYP57V8XFMhUdP6aOv34WaJiIs",
  "o0wYP5xGdH6GUcyyWuYJVl89PlXY",
];
const BASE = "https://api.carez.com.cn/paishanshi";

const LIKE_COUNT = 20;
const COMMENT_COUNT = 10;
const MAX_PAGES = 12;              // 多翻几页找未赞帖
const REQ_TIMEOUT = 12000;
const MAX_RETRY = 1;               // 仅用于列表/评论；点赞禁用
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
// 列表/评论：失败可重试（无害）
async function get(path) {
  let last;
  for (let k = 0; k <= MAX_RETRY; k++) {
    last = await requestOnce(path);
    if (!last.netFail) return last;
    if (k < MAX_RETRY) await sleep(2000);
  }
  return last;
}
// 点赞专用：绝不重发。超时也算失败并换帖，避免二次请求把赞取消
const getOnce = (path) => requestOnce(path);

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
  if (tried[uid].length > 400) tried[uid] = tried[uid].slice(-400);
}

(async () => {
  try {
    const date = new Date().toLocaleDateString("zh-CN");

    if ($persistentStore.read(LEGACY_DATE_KEY)) {
      $persistentStore.write("", LEGACY_DATE_KEY);
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
    const round = loadObj(ROUND_KEY, date);
    // 跑完一轮 = 显式标记，或 赞评都发够
    const doneOf = (uid) => {
      if (round[uid] === true) return true;
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
      if (!round[uid]) round[uid] = false;
      const p = prog[uid];
      const startL = p.like, startC = p.comment;

      if (doneOf(uid)) {
        lines.push(`账号${i + 1}：已跑完 赞${p.like} 评${p.comment}`);
        continue;
      }
      console.log(`[凯尔资] ===== 账号${i + 1} 补做 赞${p.like}/${LIKE_COUNT} 评${p.comment}/${COMMENT_COUNT} =====`);

      await get(`/shequ/mine?unionId=${uid}`);
      await sleep(1200);

      // 拉列表：fresh = 严格 agreed===0 的未赞帖；all = 全部（仅用于评论池）
      let fresh = [], all = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await get(`/shequ/list?key=&curPage=${page}&type=2&unionId=${uid}`);
        const list = (res && res.shequList) || [];
        if (!list.length) break;
        list.forEach((it) => {
          if (!it.id) return;
          all.push(it.id);
          if (it.agreed === 0) fresh.push(it.id); // 已赞(agreed=1)的绝不进点赞池
        });
        if (fresh.length >= LIKE_COUNT * 2) break; // 未赞帖已充足，无需继续翻
        await sleep(randInt(800, 1600));
      }
      all = [...new Set(all)];
      fresh = [...new Set(fresh)];
      if (!all.length) {
        lines.push(`账号${i + 1}：⚠️ 帖子列表为空（网络异常），等待补跑`);
        continue;
      }
      console.log(`[凯尔资] 账号${i + 1} 未赞帖 ${fresh.length} 个 / 全部 ${all.length} 个`);

      // 点赞池：只有未赞帖，且今天没点过的优先
      const likePool = orderByUntried(fresh, tried[uid]);
      // 评论池：全部帖子中排除本轮要点赞的，避免同帖又赞又评
      const likeIds = likePool.slice(0, LIKE_COUNT - Math.min(p.like, LIKE_COUNT));
      let commentPool = [...new Set([...all].reverse())].filter((id) => !likeIds.includes(id));
      commentPool = orderByUntried(commentPool, tried[uid]);

      let netFails = 0;
      // ---- 点赞：每帖仅一次，绝不重发 ----
      for (const id of likePool) {
        if (p.like >= LIKE_COUNT) break;
        const r = await getOnce(`/shequ/agree/commit?shequId=${id}&unionId=${uid}`);
        markTried(tried, uid, id);
        if (r && r.netFail) {
          netFails++;
          console.log(`[凯尔资] 点赞请求失败(不重发) id=${id}`);
          if (netFails >= NET_FAIL_ABORT) { aborted = true; break; }
          await sleep(1500);
          continue; // 换下一个帖子，绝不重发同一个
        }
        netFails = 0;
        p.like++; totalAdded++;
        saveObj(PROGRESS_KEY, date, prog);
        saveObj(TRIED_KEY, date, tried);
        await sleep(randInt(3000, 6000));
      }

      // ---- 评论：新增内容无 toggle，可重试 ----
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
          await sleep(randInt(5000, 10000));
        }
      }

      // 本账号完整跑完一轮（未被网络熔断）则标记，补跑点会静默跳过
      if (!aborted) round[uid] = true;
      saveObj(PROGRESS_KEY, date, prog);
      saveObj(TRIED_KEY, date, tried);
      saveObj(ROUND_KEY, date, round);

      const lack = p.like < LIKE_COUNT ? `（未赞帖仅 ${fresh.length} 个）` : "";
      lines.push(
        `账号${i + 1}：赞${p.like}/${LIKE_COUNT}${lack} 评${p.comment}/${COMMENT_COUNT}` +
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
      lines.join("\n") + "\n每帖仅点1次；实际积分以App内为准"
    );
  } catch (e) {
    console.log(`[凯尔资] 异常: ${e.stack || e}`);
    $notification.post("凯尔资 每日任务", "", `❌ 脚本异常：${e}`);
  }
  $done();
})();
