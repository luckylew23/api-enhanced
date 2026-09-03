'use strict';

// Vercel Serverless 入口。
// vercel.json 的 rewrite 把 /* 转发到 /api，本文件把 Node 的 req/res 直接交给 Express app 处理。
// 与 app.js 的区别：不监听端口（Serverless 由平台接管），不检查版本（避免冷启动额外网络请求）。
// 但必须先跑 generateConfig() 拉取 xeapi 公钥 / 匿名 token（写入 /tmp），否则 /song/url/v1 会因
// "xeapi public key is missing" 而 404。

let appPromise = null;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      try {
        const generateConfig = require('../generateConfig');
        await generateConfig();
      } catch (err) {
        // 拉取失败不致命：仅影响需要 xeapi 的个别接口，其余接口仍可工作。
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
  // Vercel 会尝试把它序列化 -> TypeError -> FUNCTION_INVOCATION_FAILED（500 崩溃）。
  // 因此：① 不返回 app 的返回值；② 等待响应真正结束（res 'finish'）后再让 handler 完成。
  //
  // 另外 Vercel rewrite 可能把 req.url 改为 "/api"，这里归一化回原始路径，
  // 让 Express 能按 /search、/song/url/v1 等路由匹配。
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
