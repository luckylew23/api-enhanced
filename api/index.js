'use strict';

// Vercel Serverless 入口（纯部署入口，不含业务逻辑）。
// 关键约束：handler 绝不能 reject，也绝不能让未捕获异常静默杀掉进程，
// 否则 Vercel 只会报笼统的 FUNCTION_INVOCATION_FAILED，真实错误被吞掉。
// 这里把任何错误都转成可读的 JSON 500 响应体，并把真实堆栈打到 stderr（Vercel 会捕获）。

// 进程级兜底：记录真实堆栈，但不退出进程，避免一次异常就让整个函数实例不可用。
function logErr(tag, err) {
  const detail = err && (err.stack || err.message || String(err));
  console.error(`[${tag}]`, detail);
}
process.on('uncaughtException', (err) => logErr('uncaughtException', err));
process.on('unhandledRejection', (reason) => logErr('unhandledRejection', reason));

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
    // 注意：getApp 内部异常会让 appPromise rejected，handler 会捕获并转成可读 500。
  }
  return appPromise;
}

module.exports = async function handler(req, res) {
  // 无论发生什么，都保证响应能结束，绝不悬挂或 reject handler。
  let settled = false;
  const safeRespond = (status, payload) => {
    if (settled) return;
    settled = true;
    try {
      if (!res.headersSent) {
        res.status(status);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(payload));
      }
    } catch (_) {
      /* ignore */
    }
  };

  let app;
  try {
    app = await getApp();
  } catch (err) {
    logErr('getApp failed', err);
    safeRespond(500, { error: 'app init failed', detail: String(err && err.message || err) });
    return;
  }

  if (!app) {
    safeRespond(500, { error: 'app is undefined' });
    return;
  }

  // Vercel 的 Node runtime 会把 handler 的【返回值】当作 HTTP 响应体发送。
  // 若直接 `return app(req, res)`，返回的是 Express app（function 对象），
  // Vercel 会尝试把它序列化 -> TypeError -> 崩溃。因此不返回 app 的返回值，
  // 而是等响应真正结束（res 'finish'）后再让 handler 完成。
  //
  // 同时把 rewrite 可能带上的 "/api" 前缀剥离，让 Express 按 /search、/song/url/v1 等路由匹配。
  if (req.url && req.url.startsWith('/api')) {
    req.url = req.url === '/api' ? '/' : req.url.slice(4) || '/';
  }

  // 安全网：万一 Express 内部异步异常导致响应既不 finish 也不 error（挂起），
  // 到时返回可读 500（真实堆栈已在上面的进程级 handler 打印到日志）。
  const SAFETY_MS = 55000;
  const safetyTimer = setTimeout(() => {
    logErr('request timeout (possible unhandled async error)', new Error('timeout'));
    safeRespond(500, {
      error: 'request did not complete',
      hint: 'check Vercel runtime logs for [uncaughtException]/[unhandledRejection] stack',
    });
  }, SAFETY_MS);

  try {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      };
      const onErr = (e) => {
        if (done) return;
        done = true;
        cleanup();
        logErr('request error', e);
        // 响应尚未发出时，返回可读 500 而不是让 handler reject。
        safeRespond(500, {
          error: 'request failed',
          detail: String(e && e.message || e),
        });
        resolve();
      };
      const cleanup = () => {
        clearTimeout(safetyTimer);
        res.removeListener('finish', finish);
        res.removeListener('error', onErr);
      };
      res.on('finish', finish);
      res.on('error', onErr);

      try {
        app(req, res);
      } catch (e) {
        onErr(e);
      }
    });
  } catch (err) {
    logErr('handler unexpected', err);
    safeRespond(500, { error: 'unexpected', detail: String(err && err.message || err) });
  }
};
