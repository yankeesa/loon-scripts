/*
 * 中国电信营业厅 - 凭证抓取 v2（yankeesa 维护）
 * 接口已迁移: wapside.189.cn:9002 → wappark.189.cn/jt-sign
 * 打开电信 APP → 首页签到, 抓取 wappark.189.cn 请求中的会话 Cookie
 * 支持: yiUIIlbdQT3fP / yiUIIlbdQT3fO 双 Cookie, 多账号去重
 */
const TITLE = '电信营业厅'
const KEY = 'dianxin_accounts_v2'

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
  const ck = parseCookieHeader(
    req.headers && (req.headers['Cookie'] || req.headers['cookie'])
  )
  const P = ck['yiUIIlbdQT3fP'] || ''
  const O = ck['yiUIIlbdQT3fO'] || ''
  if (P) {
    // 尝试从 URL/body 提取手机号
    let phone = ''
    const src = (req.url || '') + '&' + (req.body || '')
    const m = src.match(/(?:phone|mobile|accNbr|userNbr|userName)=(1\d{10})/)
    if (m) phone = m[1]

    let list = []
    try { list = JSON.parse($persistentStore.read(KEY) || '[]') } catch (e) {}
    const idx = list.findIndex(a => a.P === P)
    const acc = { P: P, O: O, phone: phone || ((idx > -1 && list[idx].phone) || ''), t: Date.now() }
    if (idx > -1) list[idx] = acc; else list.push(acc)
    $persistentStore.write(JSON.stringify(list), KEY)

    const n = list.length
    if (idx === -1) {
      $notification.post(TITLE, '获取Cookie: 成功(新账号)', '当前已存 ' + n + ' 个账号\n' + (acc.phone ? '手机号: ' + acc.phone : '⚠️ 未识别手机号, 需在脚本内 PHONES 里填写'))
    } else {
      $notification.post(TITLE, '获取Cookie: 已更新', '账号 ' + (idx + 1) + '/' + n + '\n' + (acc.phone ? '手机号: ' + acc.phone : ''))
    }
  } else {
    // 该请求未带会话 Cookie, 静默
  }
}
$done({})
