// ===================== 访问口令（ACCESS_KEY）=====================
// 背景：util/option.js 与云盘解灰层会把服务端 NETEASE_COOKIE 兜底给任意
// 匿名请求——等于任何拿到函数 URL 的人都在使用你的登录身份（读云盘、
// 以你名义发评论等）。设置 ACCESS_KEY 后，只有出示正确口令的请求才允许
// 继承该身份，其余一律按纯匿名访客处理。
//
// 用法：环境变量 ACCESS_KEY=随机串（留空/未设 = 功能关闭，行为与从前一致）
// 口令三种携带方式（兼容只改"主机"不能加参数的播放器）：
//   1. 查询串   https://域名/song/url/v1?id=xx&key=口令
//   2. 请求头   x-access-key: 口令
//   3. 路径前缀 https://域名/key/口令/song/url/v1?id=xx  ← 播放器主机填 http://域名/key/口令 即可
const crypto = require('crypto')

function getExpectedKey() {
  return (process.env.ACCESS_KEY || '').trim()
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

function extractKey(req) {
  const qKey = req.query && req.query.key
  if (typeof qKey === 'string' && qKey) return qKey
  if (req.headers && typeof req.headers['x-access-key'] === 'string') {
    return req.headers['x-access-key']
  }
  // 路径前缀已在中间件里剥离并记到 req.accessKeyVerified
  return ''
}

/**
 * Express 中间件。关闭 ACCESS_KEY 时是零开销直通。
 * 通过后 req.identityAllowed=true：该请求可继承服务端 NETEASE_COOKIE（含云盘解灰）。
 * 未通过：请求照常可用，但服务端一律按"无登录态访客"处理。
 */
function accessKeyMiddleware(req, res, next) {
  const expected = getExpectedKey()
  if (!expected) {
    req.identityAllowed = true
    return next()
  }

  const m = req.path.match(/^\/key\/([^/]+)(\/.*)?$/)
  if (m) {
    if (timingSafeEqualStr(m[1], expected)) {
      req.accessKeyVerified = true
      req.identityAllowed = true
      req.url =
        (m[2] || '/') + (require('url').parse(req.originalUrl).search || '')
      return next()
    }
    req.accessKeyVerified = false
  }

  const given = extractKey(req)
  req.identityAllowed = Boolean(given) && timingSafeEqualStr(given, expected)
  return next()
}

// 供 createOption/云盘层调用：本次请求是否允许使用服务端身份 cookie
function identityAllowed(query) {
  if (!getExpectedKey()) return true
  return Boolean(query && query.__identityAllowed)
}

module.exports = {
  accessKeyMiddleware,
  identityAllowed,
  getExpectedKey,
}
