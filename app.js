#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const tmpPath = require('os').tmpdir()

async function start() {
  // 检测是否存在 anonymous_token 文件,没有则生成
  if (!fs.existsSync(path.resolve(tmpPath, 'anonymous_token'))) {
    fs.writeFileSync(path.resolve(tmpPath, 'anonymous_token'), '', 'utf-8')
  }
  // 启动时更新anonymous_token。
  // generateConfig 内部是若干无超时的外部请求（网易域名/npm），在 Serverless
  // (SCF/Vercel) 冷启动时可能长时间挂起；绝不能在 listen 之前等待它，否则命中
  // 平台 InitContainerTimeout(450)。这里改为后台刷新：进程秒级开始服务，
  // token/公钥就绪前的少数首批请求可能报错，客户端重试即可。
  const generateConfig = require('./generateConfig')
  Promise.resolve(generateConfig()).catch(() => {})
  require('./server').serveNcmApi({
    // 纯提示性版本检查(依赖 npm 网络)，不应阻塞任何环境启动；设 CHECK_VERSION=false 关闭
    checkVersion: process.env.CHECK_VERSION !== 'false',
  })
}
start()
