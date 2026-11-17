# 华为云部署指南（个人开发者版）

> 基于 main 分支 4.41.1 实测验证（2026-11-16）。两条路线按需选一：
> **方案 A**：ECS + Node 22 + systemd（最简，推荐起步）
> **方案 B**：ECS + Docker + SWR 镜像（便于升级回滚）
>
> 文中所有「✅ 已验证」均指在写作时实际测试通过的事项。

## 0. 选型与前置决策

| 决策项 | 建议 | 说明 |
|---|---|---|
| 服务器 | 云耀云服务器 L 实例 2核2G | 本服务是单进程 Node，常驻内存 ~200MB，2C2G 足够 |
| 地域 | 国内任一（上海/广州/北京均可） | 需要访问 `music.163.com`（网易接口无地域歧视，国内直连最优） |
| 操作系统 | Ubuntu 22.04 / 24.04 | 下文命令以此为准 |
| 域名+HTTPS | 个人用可先不配 | **用 IP:端口访问不需要备案**；要绑域名走 80/443 则必须 ICP 备案 |
| 计费 | 按需选择包月 | L 实例包月最划算；先按量试跑再转包月 |

**不推荐**：FunctionGraph 函数部署。原因：启动时 `generateConfig()` 要同步刷 `anonymous_token`/`xeapi_public_key` 到 `/tmp` 并调网易接口（冷启动 +1~2s），439 条路由 + 500MB 文件上传限制 + keep-alive 连接池都不适合短生命周期函数。

## 1. 方案 A：裸机 Node + systemd（约 10 分钟）

### 1.1 服务器装 Node 22（华为云镜像源，✅ 已验证可用）

```bash
# Ubuntu
curl -fsSL https://mirrors.huaweicloud.com/nodejs/v22.9.0/node-v22.9.0-linux-x64.tar.xz -o /tmp/node.tar.xz
sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
node -v && npm -v

# pnpm（走国内镜像）
sudo npm i -g pnpm@9 --registry=https://registry.npmmirror.com
pnpm -v
```

### 1.2 拉代码

```bash
sudo apt update && sudo apt install -y git
# 公开仓库直接拉；若 fork 设了私有，用 PAT：git clone https://<PAT>@github.com/luckylew23/api-enhanced.git
cd /opt
sudo git clone https://github.com/luckylew23/api-enhanced.git ncm-api
sudo chown -R $USER ncm-api && cd ncm-api
pnpm i --frozen-lockfile --prod --ignore-scripts --registry=https://registry.npmmirror.com
```

### 1.3 配置环境变量

```bash
cd /opt/ncm-api
cp .env.prod.example .env
vim .env
```

按需修改（完整语义见 `.env.prod.example` 注释）：

```ini
# 个人自用 + 局域网/白名单访问时不需要 CORS 限制
# CORS_ALLOW_ORIGIN = "*"

# 全局解灰（VIP 歌自动换源）——按需开
ENABLE_GENERAL_UNBLOCK = false

# 想以登录态请求（VIP 音源/个人歌单等）：填网页版 cookie 里的 MUSIC_U
# NETEASE_COOKIE = "MUSIC_U=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# 云机房 IP 可能触发网易风控时，开启随机中国 IP
ENABLE_RANDOM_CN_IP = false
```

### 1.4 先手动试跑

```bash
cd /opt/ncm-api && node app.js
# 看到 ASCII banner + "Server started successfully @ http://localhost:3000" 即成功
# 另开一个终端验证：
curl -s http://127.0.0.1:3000/login/qr/key   # ✅ 应返回 unikey（写作时实测通过）
curl -I http://127.0.0.1:3000/docs/          # 200 文档站
```

> 启动细节：`app.js` 会在 `/tmp` 写 `anonymous_token` 空文件 → `generateConfig()` 请求网易刷新匿名 token、xeapi 公钥 → 监听 `PORT`(默认3000)/`HOST`(默认全部网卡)。**重启服务会自动刷新 token**，token 过期重启即可。

### 1.5 systemd 常驻

```bash
sudo tee /etc/systemd/system/ncm-api.service <<'EOF'
[Unit]
Description=NeteaseCloudMusicApiEnhanced
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/ncm-api
ExecStart=/usr/local/bin/node app.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
# NoNewPrivileges=true
# ProtectSystem=strict
# ReadWritePaths=/tmp

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now ncm-api
sudo systemctl status ncm-api        # active (running) 即成功
journalctl -u ncm-api -f             # 看实时日志
```

### 1.6 安全组放行

华为云控制台 → ECS → 安全组 → 入方向规则：
- 仅自用：添加规则放行 **3000 端口，源地址填你家的公网 IP**（百度搜"我的IP"获取）。
- 要给 App/多人用：放行 3000 对 0.0.0.0/0（务必配合第 3 节的安全措施）。

验证：`curl http://<ECS公网IP>:3000/`

> 云耀云服务器 L 实例除安全组外还有一层独立的**「防火墙」**（控制台实例详情 → 防火墙页签），两个都放行 3000 端口才通；标准 ECS 则只看安全组。

## 2. 方案 B：Docker + SWR（升级回滚更干净）

### 2.1 ECS 装 Docker（华为云镜像源，✅ 已验证可用）

```bash
curl -fsSL https://mirrors.huaweicloud.com/docker-ce/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker.gpg
echo "deb [signed-by=/usr/share/keyrings/docker.gpg] https://mirrors.huaweicloud.com/docker-ce/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io
sudo usermod -aG docker $USER && newgrp docker
```

### 2.2 镜像从哪来（重要：国内直连 Docker Hub/GHCR 基本不通）

写作时实测：本机直连 `ghcr.io` manifest 拉取超时 120s+，Docker Hub API 也不可达。**不要在 ECS 上直接 `docker pull moefurina/ncm-api` 赌运气**，两条可靠路径：

**路径一（推荐）：本地构建 → 推华为云 SWR → ECS 拉取**

```bash
# 本机（启动 Docker Desktop 后）：
cd ~/Work/api-enhanced
docker build -t ncm-api:4.41.1 .

# 华为云控制台 → SWR 容器镜像服务 → 创建组织（如 ncm）→
# 「客户端上传镜像」页生成临时登录指令（90天有效），复制执行：
docker login swr.cn-north-4.myhuaweicloud.com   # 地域按你的实际 region 改

docker tag ncm-api:4.41.1 swr.cn-north-4.myhuaweicloud.com/ncm/ncm-api:4.41.1
docker tag ncm-api:4.41.1 swr.cn-north-4.myhuaweicloud.com/ncm/ncm-api:latest
docker push swr.cn-north-4.myhuaweicloud.com/ncm/ncm-api:4.41.1
docker push swr.cn-north-4.myhuaweicloud.com/ncm/ncm-api:latest
```

```bash
# ECS 上（同 region 拉取走内网，秒级）：
docker pull swr.cn-north-4.myhuaweicloud.com/ncm/ncm-api:latest
docker run -d --name ncm-api --restart unless-stopped \
  -p 3000:3000 \
  --env-file /opt/ncm-api/.env \
  swr.cn-north-4.myhuaweicloud.com/ncm/ncm-api:latest
```

> ⚠️ **构建前确认项目根目录没有 `.env`**：本仓库 `.dockerignore` 为适配 Vercel 显式放行了 `.env`（`!/.env`），本地存在 `.env` 时构建会把它烤进镜像。构建镜像时保持无 `.env`，运行时一律用 `--env-file` 注入。

> 注意 Dockerfile 里 `CMD` 已用 `tini` 托管，`--restart unless-stopped` 即可自愈；token 在容器 `/tmp`，容器重启自动刷新。

**路径二：直接在 ECS 上构建**。给 Docker 配多个公共 Hub 加速器（时效性强，失效就换）：

```json
// /etc/docker/daemon.json
{ "registry-mirrors": ["https://docker.1ms.run", "https://docker.xuanyuan.me"] }
```

```bash
sudo systemctl restart docker
cd /opt && git clone https://github.com/luckylew23/api-enhanced.git ncm-api-src
cd ncm-api-src && docker build -t ncm-api:local .
```

### 2.3 升级流程

```bash
# 方案 B 升级 = 本机 build+push，ECS：
docker pull .../ncm-api:latest && docker rm -f ncm-api && docker run ...（同上）
# 或用 docker compose 维护，配置即代码
```

## 3. 安全加固（个人开发者必做）

1. **这个 API 默认无鉴权**——任何能访问端口的人都可以用你的 cookie 请求网易云接口。个人使用：
   - 安全组只放行自己的 IP（最有效）；
   - 或套 Nginx + Basic Auth / IP 白名单；
   - 绝不要裸奔到公网 0.0.0.0/0 还带 `NETEASE_COOKIE`。
2. `NETEASE_COOKIE` 只放在服务器 `.env` 或容器 env，**不要提交进 git**（`.gitignore` 已忽略 `.env`）。
3. `ENABLE_GENERAL_UNBLOCK=true` 会让所有 `/song/url/v1` 请求走解灰外部音源，公网暴露时慎开（流量+法律边界都不可控）。
4. ECS 出方向默认全通，无需改；入方向按最小化原则。

## 4. 升级代码（方案 A）

```bash
cd /opt/ncm-api
git fetch origin && git checkout main && git pull origin main   # 本地仓库跟远程 main
pnpm i --frozen-lockfile --prod --ignore-scripts --registry=https://registry.npmmirror.com
sudo systemctl restart ncm-api
journalctl -u ncm-api -n 20     # 确认 banner 出现、无报错
```

上游更新跟随流程见 AGENTS.md / 日常两条命令（`git pull upstream main` 后 push origin main，服务器再 pull）。

## 5. 故障排查

| 症状 | 处置 |
|---|---|
| 启动报 `anonymous_token` 相关错误 | `rm /tmp/anonymous_token*` 后重启服务（会重新生成） |
| 接口返回风控/验证码类错误 | 云机房 IP 被网易风控：开启 `ENABLE_RANDOM_CN_IP=true` 或带 `NETEASE_COOKIE`，仍不行则换地域 |
| `/song/url/v1` 全部拿不到链接 | 检查 `ENABLE_GENERAL_UNBLOCK`；解灰外部音源（kuwo/gdmusic 等）本身也会波动，看日志 `Unblock failed` |
| `pnpm i` 卡住 | 确认走了 `--registry=https://registry.npmmirror.com` |
| 端口不通 | 先 `curl 127.0.0.1:3000` 区分是服务问题还是安全组问题 |
| 内存不足 OOM | 2G 内存建议加 2G swap：`sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile` |

## 6. 本次实测验证清单（写作时）

- ✅ `music.163.com` 从国内网络直连 175ms，`/login/qr/key` 真实请求返回 200 + unikey
- ✅ `mirrors.huaweicloud.com` nodejs（v22.9.0）与 docker-ce 源均可达
- ✅ `registry.npmmirror.com` 可达（386ms）
- ✅ `serveNcmApi` 监听 `PORT`/`HOST` 环境变量，HOST 默认空 = 0.0.0.0，容器/ECS 无需改代码
- ✅ 根路径 `/` 与 `/docs/` 静态资源 200
- ✅ 官方镜像地址：`moefurina/ncm-api`（Docker Hub）与 `ghcr.io/neteasecloudmusicapienhanced/ncm-api`，amd64+arm64 双架构（但国内直连拉取超时，建议走 SWR）
- ⚠️ 未能实测：华为云 ECS 机房 IP 访问网易接口的风控表现（云数据中心 IP 偶发更严，遇到时按第 5 节处置）
