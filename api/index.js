'use strict';

// Vercel Serverless 入口。
// vercel.json 的 rewrite 把 /* 转发到 /api，本文件把 Node 的 req/res 直接交给 Express app 处理。
// 与 app.js 的区别：不监听端口（Serverless 由平台接管），不检查版本（避免冷启动额外网络请求）。
// 但必须先跑 generateConfig() 拉取 xeapi 公钥 / 匿名 token（写入 /tmp），否则 /song/url/v1 会因
// "xeapi public key is missing" 而 404。

let appPromise = null;

async function getApp() {
  if (!appPromise) {
    try {
      const generateConfig = require('../generateConfig');
      await generateConfig();
    } catch (err) {
      console.error('generateConfig failed (non-fatal):', err && err.message);
    }
    try {
      const { serveNcmApi } = require('../server');
      appPromise = serveNcmApi({ checkVersion: false });
    } catch (err) {
      appPromise = Promise.reject(err);
      throw err;
    }
  }
  return appPromise;
}

module.exports = async function handler(req, res) {
  const app = await getApp();
  return app(req, res);
};
