# api-enhanced 项目记忆（个人部署状态，非上游公共文档）

## 部署形态
- 唯一工作副本：本目录（git clone）。origin=luckylew23/api-enhanced（fork，每日 Upstream Sync 自动同步上游），upstream=NeteaseCloudMusicApiEnhanced/api-enhanced。main = 上游最新 + 个人增强，无 V2 分支（已删，历史在 V2-archive tag）。
- 生产环境：腾讯云 SCF Web 函数 `api-enhanced`（广州），入口 scf_bootstrap（PORT=9000），函数 URL https://1302542075-6gn69gazqr.ap-guangzhou.tencentscf.com，执行超时 65s。
- 打包：`bash scripts/make-scf-zip.sh` → ~/Downloads/ncm-api-scf.zip（16.3MB 唯一标准包；>1M 图片自动剔除；构建走 git archive HEAD + npm ci --omit=dev）。控制台"函数代码→zip 上传"部署，勿用 Cloud Studio 插件（TLS 不稳）。
- 旧目录归档：~/Work/api-enhanced-v4.40.1-old、~/Work/api-enhanced-v2-old、~/Work/api-enhanced-v2.zip。

## 环境变量（SCF 控制台）
NETEASE_COOKIE=MUSIC_U=xxx（必须带 MUSIC_U= 键名前缀，裸值会被当匿名；本人云盘 284 首）· ENABLE_GENERAL_UNBLOCK=true · ENABLE_CLOUD_UNBLOCK=true（已线上验证生效）· SELECT_MAX_BR=true · ENABLE_RANDOM_CN_IP=true（治 HK 访问地域限制，HK 节点实测 200）

## 本仓库特有增强（相对上游）
1. 启动非阻塞：listen 不等 generateConfig/checkVersion（否则 SCF InitContainerTimeout 450）。
2. unblockMatch（util/index.js）：假外链过滤、http→https、unm 首位、SELECT_MAX_BR/FOLLOW_SOURCE_ORDER 假值字符串归一化。
3. 云盘优先解灰（util/cloudUnblock.js）：灰歌先查本人云盘（索引 TTL 10min，匿名请求回退 NETEASE_COOKIE——注意 query.cookie 空对象坑），命中官方 CDN 无酷我播报；未命中落第三方池。
4. server.js：req.path 判断解灰路由（上游 req.baseUrl 恒空是死代码）；触发条件=官方无可播链接/仅试听。
5. 平台事实：SCF 默认测试域名被 openresty 强注 Content-Disposition:attachment（HTML 必被下载，应用层无解）；*.tencentscf.com 境外可直连。酷我系(kuwo/bodian 同源)为第三方池唯一活源，播报文件=M 开头通道，bodian FLAC 无播报。

## 验收探针
- 云盘生效：解灰返回 m*.music.163.com；kuwo 域名=云盘未命中。
- 缓存绕过：任意 URL 加 &cb=随机。
- 环境坑：PATH 里 DevEco diff 不可靠用 /usr/bin/diff、cmp；本机到 github.com 时通时断，push 失败重试即可。
