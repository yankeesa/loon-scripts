/*
 * 中国电信营业厅 - 凭证抓取（Loon 原生版，yankeesa 维护）
 * 打开电信APP → 我 → 签到，自动捕获签到请求并存储手机号/签名体
 */
const cookieName = '电信营业厅'
const KEY_signheader = 'chavy_signheader_10000'
const KEY_signbody = 'chavy_signbody_10000'
const KEY_mobile = 'chavy_mobile_10000'

const req = (typeof $request !== 'undefined') ? $request : null
if (req && req.headers) {
  const url = req.url || ''
  const body = req.body || ''
  const low = url.toLowerCase()
  const keyword = ['sign', 'bean', 'gold', 'coin', 'score', 'point', 'task',
    'checkin', 'activity', 'home', 'user', 'login', 'index', 'jt', 'dakan',
    'goldcoin', 'integral', 'grow', 'attendance', 'daily']
  const hit = keyword.some(k => low.includes(k))
  if (hit) {
    $persistentStore.write(JSON.stringify(req.headers), KEY_signheader)
    if (body) $persistentStore.write(body, KEY_signbody)
    // 提取手机号（兼容多种字段名）
    let mobile = ''
    try {
      const obj = (typeof body === 'string') ? JSON.parse(body) : (body || {})
      mobile = obj.mobileNo || obj.phone || obj.accNbr || obj.mobile ||
        obj.userName || obj.userNbr || obj.number || ''
      if (Array.isArray(mobile)) mobile = mobile[0] || ''
    } catch (e) {}
    if (mobile) $persistentStore.write(mobile, KEY_mobile)
    const u = url.split('?')[0]
    $notification.post(
      cookieName,
      '获取Cookie: 成功',
      (mobile ? ('手机号: ' + mobile + '\n') : '（未识别手机号）\n') +
      '方法: ' + (req.method || 'GET') + '\n' +
      '路径: ' + u + '\n' +
      (body ? ('BODY: ' + body.slice(0, 180)) : '（无body，纯GET）')
    )
  }
}
$done({})
