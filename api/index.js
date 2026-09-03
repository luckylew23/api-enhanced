'use strict';

// Vercel Serverless 入口（纯部署入口，不含业务逻辑）。
// vercel.json 的 rewrite 把 /* 转发到 /api，本文件把 Node 的 req/res 交给 Express app 处理。
// 与 app.js 的区别：不监听端口（Serverless 由平台接管）、不检查版本（避免冷启动额外网络请求）。
// 业务逻辑（匿名 token 读取、解灰等）都在 server.js / util/request.js / generateConfig.js 中，
// 且这些文件自身已对“文件可能不存在”等场景做了容错，不依赖本文件的特殊处理。

let appPromise = null;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      // 拉取 xeapi 公钥 / 匿名 token（写入 /tmp）。失败不致命：仅影响个别接口。
      try {
        const generateConfig = require('../generateConfig');
        await generateConfig();
      } catch (err) {
        console.error('generateConfig failed (non-fatal):', err && err.message);
      }
      const { serveNcmApi } = require('../server');
      return serveNcmApi({ checkVersion: false });
    })();
  }
  return appPromise;
}

module.exports = async function handler(req, res) {
  const app = await getApp();

  // Vercel 的 Node runtime 会把 handler 的【返回值】当作 HTTP 响应体发送。
  // 若直接 `return app(req, res)`，返回的是 Express app（一个 function 对象），
  // Vercel 会尝试把它序列化 -> TypeError -> 500 崩溃。因此不返回 app 的返回值，
  // 而是等响应真正结束（res 'finish'）后再让 handler 完成。
  //
  // 同时把 rewrite 可能带上的 "/api" 前缀剥离，让 Express 按 /search、/song/url/v1 等路由匹配。
  if (req.url && req.url.startsWith('/api')) {
    req.url = req.url === '/api' ? '/' : req.url.slice(4) || '/';
  }

  await new Promise((resolve, reject) => {
    let finished = false;
    const onFinish = () => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve();
    };
    const onError = (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      res.removeListener('finish', onFinish);
      res.removeListener('error', onError);
    };
    res.on('finish', onFinish);
    res.on('error', onError);

    try {
      app(req, res);
    } catch (err) {
      onError(err);
    }
  });
};
