// ===================== 云盘优先解灰 =====================
// 思路：用户网易云盘里存过的歌，云盘文件本身是网易歌曲体系的合法 songId，
// 走官方 /api/song/enhance/player/url 即可拿到 m*.music.163.com CDN 直链——
// 无版权下架限制、无第三方（酷我）营销语音播报、音质即上传时的文件。
// 因此对"官方拿不到可播链接"的灰歌，先查云盘索引，命中直出官方链接，
// 未命中再落第三方解灰池（unblockMatch）。
//
// 开关：环境变量 ENABLE_CLOUD_UNBLOCK=true 时启用（默认关闭）。
// 需要登录 cookie（query.cookie / NETEASE_COOKIE），匿名态自动跳过。
// 可调：CLOUD_UNBLOCK_TTL（索引缓存毫秒，默认 600000）、
//       CLOUD_UNBLOCK_MAX（索引拉取上限首数，默认 5000）。

const logger = require('./logger')
const createOption = require('./option')

const CLOUD_PAGE_LIMIT = 300

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

async function fetchCloudList(query, request) {
  const maxSongs = Number(process.env.CLOUD_UNBLOCK_MAX || '5000')
  const out = []
  let offset = 0
  while (offset < maxSongs) {
    const res = await request(
      '/api/v1/cloud/get',
      {
        limit: String(CLOUD_PAGE_LIMIT),
        offset: String(offset),
      },
      createOption(query, 'weapi'),
    )
    const data = (res && res.body && res.body.data) || []
    out.push(...data)
    if (data.length < CLOUD_PAGE_LIMIT) break
    offset += CLOUD_PAGE_LIMIT
  }
  return out
}

// 官方 songId -> 云盘 songId。字段做防御式兼容：
// 云盘项的 songId 为云盘歌曲 id；匹配到官方库时挂在 simpleSong(或 song).id。
function buildCloudMap(list) {
  const map = new Map()
  for (const item of list || []) {
    const official =
      (item.simpleSong && item.simpleSong.id) ||
      (item.song && item.song.id) ||
      null
    const cloud = item.songId || null
    if (official && cloud && String(official) !== String(cloud)) {
      map.set(String(official), String(cloud))
    }
  }
  return map
}

// 进程级缓存：按 cookie 账户分Key，TTL 内复用；并发共享同一份在途请求
const cache = new Map()

function getCloudIndex(query, request) {
  const key = cookieSignature(query.cookie) || 'anon'
  const ttl = Number(process.env.CLOUD_UNBLOCK_TTL || '600000')
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.map && now - hit.fetchedAt < ttl) {
    return Promise.resolve(hit.map)
  }
  if (hit && hit.promise) return hit.promise

  const promise = fetchCloudList(query, request)
    .then((list) => {
      const map = buildCloudMap(list)
      cache.set(key, { map, fetchedAt: Date.now(), promise: null })
      logger.info(`Cloud unblock index built: ${map.size} matched songs`)
      return map
    })
    .catch((error) => {
      logger.error('Cloud unblock index failed:', error && error.message)
      cache.set(key, { map: null, fetchedAt: Date.now(), promise: null })
      return null
    })
  cache.set(key, { map: hit ? hit.map : null, fetchedAt: now, promise })
  return promise
}

/**
 * 云盘优先解灰：官方 id -> 云盘文件 -> 官方 CDN 直链。
 * @param {string|number} id 请求的官方歌曲 id
 * @param {object} query 含 cookie 的查询对象
 * @param {Function} request 注入 ip 后的请求函数（server.js 的包装版）
 * @returns {Promise<{code:number,message:string,data:object}|null>} 与 unblockMatch 同构；null=未命中/未启用
 */
async function cloudMatch(id, query, request) {
  if (process.env.ENABLE_CLOUD_UNBLOCK !== 'true') return null
  // 请求未带 cookie 时回退到服务端 NETEASE_COOKIE（与 createOption 的
  // 回退语义一致）。判据用 cookieSignature 而非对象真值：匿名请求里
  // query.cookie 常是 {}（truthy 空对象），直接取它会挡住环境变量回退。
  const raw = query && query.cookie
  const effCookie = cookieSignature(raw)
    ? raw
    : query && query.__identityAllowed === false
      ? ''
      : process.env.NETEASE_COOKIE || ''
  if (!cookieSignature(effCookie)) return null

  const map = await getCloudIndex(
    Object.assign({}, query, { cookie: effCookie }),
    request,
  )
  if (!map) return null
  const cloudId = map.get(String(id))
  if (!cloudId) return null

  try {
    const res = await request(
      '/api/song/enhance/player/url',
      {
        ids: JSON.stringify([String(cloudId)]),
        br: '999000',
      },
      createOption(Object.assign({}, query, { cookie: effCookie }), 'weapi'),
    )
    const song = res && res.body && res.body.data && res.body.data[0]
    if (song && song.code === 200 && song.url) {
      return {
        code: 200,
        message: 'success',
        data: {
          url: song.url,
          source: 'cloud',
          cloudId: Number(cloudId),
          br: song.br,
          size: song.size,
          type: song.type,
        },
      }
    }
    logger.warn(
      `Cloud song ${cloudId} url not ready (code=${song && song.code})`,
    )
  } catch (error) {
    logger.error('Cloud url fetch failed:', error && error.message)
  }
  return null
}

module.exports = {
  cloudMatch,
  buildCloudMap,
  cookieSignature,
  __resetCloudCache: () => cache.clear(),
}
