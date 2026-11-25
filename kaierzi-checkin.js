/* ==================== v9 多设备并发保护（仅外层包裹，原逻辑一字未改） ====================
 * iPad / iPhone 共用同一套配置且强制同步时，两台会在同一时刻各跑一遍，
 * 对同一批新帖各点一次赞；点赞接口是 toggle，第二次正好取消第一次 → 每日点赞 0 分。
 * 关键：Loon 的 $persistentStore 是【每台设备本地】的，不随配置同步
 *      （你观察到「两台各记各的进度」正是证据），所以角色可以存在这里，
 *      两台的插件/配置完全一样，但只有主设备真正跑定时。
 *   idle    = 副设备，静默退出；primary / 未设置 = 主设备，正常跑。
 * 在副设备上手动运行一次「凯尔资_设备角色_手动运行」即可写入 idle。
 * ==================================================================================== */
const ROLE_KEY = "kaierzi_role_v9";
const ROLE_WARN_KEY = "kaierzi_role_warned_v9";
const _role = $persistentStore.read(ROLE_KEY);
if (_role === "idle") {
  $done();
} else {
  if (_role !== "primary" && $persistentStore.read(ROLE_WARN_KEY) !== "1") {
    $persistentStore.write("1", ROLE_WARN_KEY);
    $notification.post(
      "凯尔资 · 请先设置设备角色",
      "请在【副设备】手动运行一次「凯尔资_设备角色_手动运行」",
      "两台设备同时跑会互相取消点赞，导致每日点赞 0 分；只需设置一次。"
    );
  }
/**
 * 凯尔资商城小程序 —— 每日任务 v8（多账号）
 * 每账号：登录 + 点赞(上限20) + 评论(上限10)
 *
 * v8 根治「点赞只拿到 6~18 分、补跑从来不生效」：
 *   2026-11-17 实测结论：
 *     - 点赞请求 4/4 真实生效（agreed 0->1、agreeCount+1），接口/请求头/字段类型全都没问题；
 *       agreed 是标准整数 0/1，且按 unionId 独立。
 *     - 「未赞帖(agreed=0)」随时间增长：社区白天不断发新帖，10:22 时 U1 已有 114 个未赞帖，
 *       而 10:05 主跑那一刻新帖尚未发出，能凑到的未赞帖可能只有寥寥几个。
 *     - 当天 U1 只有 6 个「已赞帖」，正好 = 截图里的 18 分（6 赞 x3）。
 *   真因不在接口，在【完成判定 + 池子时序】：
 *     v7 的 `if (!aborted) round[uid]=true` 只要没网络熔断就标记「本轮跑完」，
 *     哪怕因 10:05 新帖少 / 翻页被网络抖动截断，只点上了 6 个赞。
 *     之后补跑点 `doneOf()` 看到 round=true 直接静默跳过 → 缺的 14 个赞整天补不回来。
 *     而评论池用「全部帖子」不受新帖限制，所以评论总能满 50 分、点赞却长期残缺。
 *
 * v8 三处修复：
 *   1) 完成判定只认真实进度（赞>=20 且 评>=10），彻底删除 round 提前标记；
 *      没点满就绝不静默放过，补跑点一定会继续补缺额。
 *   2) 补跑点(14:05)重新拉列表，吃到白天新发的帖子，只补还差的数量。
 *   3) 翻页遇到单页空/网络抖动不再立即 break，继续尝试后续页，避免池子被截小。
 *
 * 保留 v7 实证有效的点赞三铁律（接口是 toggle，重复点=取消赞）：
 *   - 点赞池只收 agreed===0 的未赞帖；
 *   - 点赞请求绝不重发，超时/失败直接换下一帖；
 *   - 每帖本轮只点一次；补跑时已赞帖 agreed=1 自动排除，不会取消旧赞。
 *   评论是新增内容、无 toggle 语义，保持可重试。
 *
 * 本套接口靠 URL 里的 unionId 鉴权，请求头无 token；进度按真实发出的请求数计。
 */
/* v11 根治「提示跳过 / 补跑无效 / 点赞常年不满」：
 * 本地进度只记「发出去的请求数」，两台设备并发 toggle 抵消、或赞被取消后，
 * 本地仍显示 20/20，脚本就整天误判完成、再也不补 —— 这是 v4 以来所有同类问题的总根。
 * v11 改为每次运行先用服务端 shequ/list 的 agreed 字段实测「今日已赞帖数」，
 * 用它覆盖本地 like 计数，作为唯一可信的完成依据；本地虚高会被自动纠正。
 * 点赞池同时限定为「今日新帖且 agreed=0」，与校准口径一致，避免点到老帖统计不到。
 */
const UIDS_KEY = "kaierzi_unionids";
const PROGRESS_KEY = "kaierzi_progress_v11";  // like 由服务端实测校准, comment 仍为本地计数
const TRIED_KEY = "kaierzi_tried_v11";        // { 日期: { uid: [shequId...] } } 换帖记录
const PREV_KEY = "kaierzi_srvliked_prev_v11"; // 上次服务端实测值, 用于检测「赞被取消」
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
const EMPTY_PAGE_ABORT = 3;        // 连续这么多页拉不到数据才判定列表到底

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

// ---- v11 服务端校准 ----
function todayKey() {
  const d = new Date();
  return "" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}
function isToday(it) {
  // addDate 形如 2026.11.25
  const s = String(it.addDate || "").replace(/\D/g, "");
  return s.slice(0, 8) === todayKey();
}
// 从服务端读「今日新帖中 agreed=1 的数量」——唯一可信的今日点赞进度
async function fetchTodayLiked(uid) {
  let liked = 0, seen = 0;
  for (let page = 1; page <= 10; page++) {
    const res = await get(`/shequ/list?key=&curPage=${page}&type=2&unionId=${uid}`);
    if (!res || res.netFail) break;
    const list = (res && res.shequList) || [];
    if (!list.length) break;
    let todayCnt = 0;
    for (const it of list) {
      if (!it.id || !isToday(it)) continue;
      todayCnt++; seen++;
      if (it.agreed === 1) liked++;
    }
    if (todayCnt === 0) break; // 列表按发帖时间倒序, 整页都不是今天 -> 后面更旧
    await sleep(randInt(250, 600));
  }
  return { liked, seen };
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

    // ===== v11: 用服务端实测覆盖本地虚高进度（并发抵消后本地仍显示满额的老坑）=====
    let prevAll = {};
    try { prevAll = JSON.parse($persistentStore.read(PREV_KEY) || "{}"); } catch (e) {}
    const prev = prevAll[date] || {};
    let canceled = false;
    for (const uid of uids) {
      const st = await fetchTodayLiked(uid);
      if (prev[uid] != null && st.liked < prev[uid]) canceled = true;
      prev[uid] = st.liked;
      prog[uid] = { like: st.liked, comment: (prog[uid] && prog[uid].comment) || 0 };
      console.log(`[凯尔资] 服务端实测今日已赞 ${st.liked} 个（今日帖 ${st.seen} 个）`);
    }
    $persistentStore.write(JSON.stringify({ [date]: prev }), PREV_KEY);
    saveObj(PROGRESS_KEY, date, prog);
    if (canceled) {
      $notification.post(
        "凯尔资 · 点赞被取消",
        "疑似另一台设备仍在并发跑签到",
        "请确认【副设备】已运行「设为副设备」一次；否则点赞会一直互相抵消。"
      );
    }
    // v8：完成只认真实进度，不再有「跑过一轮就当完成」的标记
    const doneOf = (uid) => {
      const p = prog[uid] || { like: 0, comment: 0 };
      return p.like >= LIKE_COUNT && p.comment >= COMMENT_COUNT;
    };
    if (uids.every(doneOf)) {
      console.log("[凯尔资] 今日两账号赞评均已满，跳过（补跑点静默）");
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

      await get(`/shequ/mine?unionId=${uid}`);
      await sleep(1200);

      // 拉列表：fresh = 严格 agreed===0 的未赞帖；all = 全部（仅用于评论池）
      // v8：单页空/网络抖动不再立即 break，继续尝试后续页，避免把池子截小
      let fresh = [], all = [], emptyStreak = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await get(`/shequ/list?key=&curPage=${page}&type=2&unionId=${uid}`);
        const list = (res && res.shequList) || [];
        if (!list.length) {
          emptyStreak++;
          if (emptyStreak >= EMPTY_PAGE_ABORT) break;
          await sleep(randInt(1000, 1800));
          continue;
        }
        emptyStreak = 0;
        list.forEach((it) => {
          if (!it.id) return;
          all.push(it.id);
          if (it.agreed === 0 && isToday(it)) fresh.push(it.id); // v11: 只收今日未赞帖, 与服务端校准口径一致
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

      saveObj(PROGRESS_KEY, date, prog);
      saveObj(TRIED_KEY, date, tried);

      const lack = p.like < LIKE_COUNT ? `（未赞帖仅 ${fresh.length} 个，补跑继续找新帖）` : "";
      lines.push(
        `账号${i + 1}：赞${p.like}/${LIKE_COUNT}${lack} 评${p.comment}/${COMMENT_COUNT}` +
        `（本次 +${p.like - startL}赞 +${p.comment - startC}评）`
      );
      if (aborted) break;
      if (uids.length > 1) await sleep(randInt(5000, 10000));
    }

    const nowDone = uids.every(doneOf);
    if (nowDone && totalAdded === 0) return $done(); // 补跑点：真已完成，静默

    const sub = aborted
      ? "⚠️ 网络异常，已存进度，补跑点继续"
      : nowDone
        ? "✅ 今日赞评均已满（补跑点将静默跳过）"
        : "⏳ 点赞未满额（新帖还不够），14:05 补跑继续补齐";
    $notification.post(
      "凯尔资 每日任务",
      sub,
      lines.join("\n") + "\n进度=服务端实测今日已赞帖数（自动纠正本地虚高）；实际积分以App内为准"
    );
  } catch (e) {
    console.log(`[凯尔资] 异常: ${e.stack || e}`);
    $notification.post("凯尔资 每日任务", "", `❌ 脚本异常：${e}`);
  }
  $done();
})();

}
