// ===================== 云盘优先解灰 =====================
// 思路：灰歌先直接试云盘取链接口 /api/cloud/dowonload（eapi）。
// 网易云盘机制：上传的歌若匹配官方库，云盘记录 songId == 官方 id
// （2026-11-17 线上实测：matched 与 unmatched 记录均同 id），因此无需
// 拉列表建索引——对请求 id 一次直查即可：
//   · 云盘有此歌   → 秒回 m*.music.163.com 官方 CDN 直链（无第三方播报）
//   · 云盘无此歌   → 非 200/无 url → 返回 null，透明落第三方解灰池
// 需要有效登录 cookie：请求自带优先，否则回退服务端 NETEASE_COOKIE。
// 开关：ENABLE_CLOUD_UNBLOCK=true（默认关闭）。
const logger = require('./logger')
const createOption = require('./option')

function cookieSignature(cookie) {
  // 以 MUSIC_U 区分账户；cookie 可能是字符串或对象
  try {
    if (typeof cookie === 'string') {
      const m = cookie.match(/MUSIC_U=([^;]+)/)
      return m ? m[1] : ''
    }
    if (cookie && typeof cookie === 'object') {
      return cookie.MUSIC_U || ''
    }
  } catch (_) {}
  return ''
}

/**
 * 云盘直查解灰：单次调用，无索引无缓存。
 * @param {string|number} id 官方歌曲 id（云盘 matched 记录与之同 id）
 * @param {object} query 查询对象（可含 cookie / __identityAllowed）
 * @param {Function} request 注入 ip 后的请求函数
 * @returns {Promise<{code:number,message:string,data:object}|null>}
 *          与 unblockMatch 同构；null=未命中/未启用/无有效身份
 */
async function cloudMatch(id, query, request) {
  if (process.env.ENABLE_CLOUD_UNBLOCK !== 'true') return null

  // 匿名请求的 query.cookie 常是 {}（truthy 空对象），用签名判据
  // 才能正确回退环境变量；ACCESS_KEY 门控关闭身份时(__identityAllowed
  // === false)禁止回退——访客不得继承本人登录态。
  const raw = query && query.cookie
  const effCookie = cookieSignature(raw)
    ? raw
    : query && query.__identityAllowed === false
      ? ''
      : process.env.NETEASE_COOKIE || ''
  if (!cookieSignature(effCookie)) return null

  const q = Object.assign({}, query, { cookie: effCookie })
  try {
    const res = await request(
      '/api/cloud/dowonload',
      { songId: String(id) },
      createOption(q, 'eapi'),
    )
    const body = (res && res.body) || {}
    if (body.code === 200 && body.url) {
      return {
        code: 200,
        message: 'success',
        data: {
          url: body.url.replace(/^http:\/\//i, 'https://'),
          source: 'cloud',
          size: body.size,
          name: body.name,
        },
      }
    }
    return null
  } catch (error) {
    // 云盘无此歌时接口按错误返回：属正常 miss，静默降级
    logger.debug &&
      logger.debug(`cloud probe miss for ${id}: ${error && error.message}`)
    return null
  }
}

module.exports = {
  cloudMatch,
  cookieSignature,
}
