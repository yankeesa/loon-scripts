/*
 * 中国电信营业厅 - 凭证抓取 v2.1（yankeesa 维护）
 * 接口: wappark.189.cn/jt-sign  (旧 wapside.189.cn:9002 已废弃)
 * 打开电信 APP → 签到页, 抓取 wappark.189.cn 请求中的会话 Cookie
 * 单账号覆盖式: 同一号码只保留最新一组 Cookie(O 可能随请求刷新)
 */
const TITLE = '电信营业厅'
const KEY = 'dianxin_accounts_v2'
const FLAG = 'dianxin_notify_flag'

function parseCookieHeader(str) {
  const out = {}
  ;(str || '').split(';').forEach(kv => {
    const i = kv.indexOf('=')
    if (i > -1) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim()
  })
  return out
}

const req = (typeof $request !== 'undefined') ? $request : null
if (req) {
  const ck = parseCookieHeader(req.headers && (req.headers['Cookie'] || req.headers['cookie']))
  const P = ck['yiUIIlbdQT3fP'] || ''
  const O = ck['yiUIIlbdQT3fO'] || ''
  if (P) {
    // 严格手机号: 1[3-9] + 9 位数字, 且不与更长数字粘连
    let phone = ''
    const src = (req.url || '') + '&' + (req.body || '')
    const m = src.match(/(?:phone|mobile|accNbr|userNbr|userName|num)[=:]"?(1[3-9]\d{9})(?!\d)/)
    if (m) phone = m[1]

    // 读取(兼容旧 v2 数组格式)
    let acc = null
    try {
      const old = $persistentStore.read(KEY)
      if (old) {
        const parsed = JSON.parse(old)
        acc = Array.isArray(parsed) ? (parsed.filter(a => a && a.P).pop() || null) : parsed
      }
    } catch (e) {}
    if (!acc || typeof acc !== 'object') acc = {}

    const prevPhone = acc.phone || ''
    acc.P = P
    acc.O = O
    acc.t = Date.now()
    if (phone) acc.phone = phone
    $persistentStore.write(JSON.stringify(acc), KEY)

    // 仅弹一次通知, 避免每次请求刷屏(已识别过手机号或已提示过则静默)
    let flagged = $persistentStore.read(FLAG) === '1'
    let notify = null
    if (phone && prevPhone !== phone) notify = '手机号: ' + phone
    else if (!phone && !flagged) notify = '已捕获会话Cookie, 未识别手机号 → 把电信号码发我写入脚本'
    if (notify !== null) {
      $persistentStore.write('1', FLAG)
    }

    if (notify !== null) {
      $notification.post(TITLE, '获取Cookie: 成功', notify)
    }
  }
  // 该请求不含会话 Cookie 或非 wappark 域, 静默
}
$done({})
