/**
 * dsh-unread —— host 半。
 *
 * 原生会话状态里的「未读」（`completionUnread`）由 host 侧按模型完成事件算出，
 * 浏览器半改不了它：它描述的是「这一轮回复你没看过」，不是一个可以手动翻转的
 * 标记。所以手动「标为未读」需要自己的一份状态，这里就是那份状态的唯一所在。
 *
 * 状态存在 DSH 的 domain 存储里（`ctx.storageDomain`），不是 localStorage：
 * 同一台 host 上的浏览器、不同浏览器、重启之后都读同一份，这才是「跨浏览器
 * 同步」。浏览器半只做两件事：读快照、发变更；写入永远回到这里。
 *
 * 四个端点：
 *   GET  /plugin/dsh-unread/state   读全量标记；
 *   POST /plugin/dsh-unread/mark    翻转一条标记；
 *   GET  /plugin/dsh-unread/events  SSE，把别人的变更推给这个标签页；
 *   GET  /plugin/dsh-unread/health  安装自检（浏览器半装载后也会来打一次卡）。
 *
 * 依赖保持可选：组合里没有 storage-domain 就整块不装载（没有可存的地方），
 * 没有 webServer 就少了端点。两种情况都不抛错，缺什么少什么。
 */

/** cordis 插件名。 */
export const name = 'dsh-unread';

/** 不强制注入服务；storage-domain 与 webServer 都在 apply 里按可选依赖解析。 */
export const inject = [];

/** 插件版本，健康检查里回显。 */
export const version = '0.1.0';

/**
 * domain 名。必须是 `UNIT_NAME_RE`（`/^[a-z][a-z0-9_]*$/`）的形状，且在所有
 * 插件里唯一——`storage-domain` 按名字占用，撞名会 already-open。
 */
const DOMAIN_NAME = 'dsh_unread';

/** 表名，同样受 `UNIT_NAME_RE` 约束。 */
const TABLE = 'marks';

/** 单条请求体上限：这里只收一个 id 和一个布尔值。 */
const BODY_LIMIT = 8 * 1024;

/** 会话 id 的长度上限，纯粹是拒绝垃圾输入。 */
const SESSION_ID_LIMIT = 200;

/**
 * 一条标记的校验器。
 *
 * `storage-domain` 把每条记录的 schema 当作「介质里读出来的东西」的闸门：断电
 * 后的半条 JSON、手改过的文件、旧版本写下的形状，都要在装载时被拦成
 * `invalid-record`，而不是流进内存变成一个假记录。这里手写 `parse` 而不引 zod，
 * 是为了让这个包在 host 侧零运行时依赖——直接软链进 profile 就能跑，不需要
 * 先 `npm install`。重建对象同时也起到 strict 的作用：多出来的键会被丢掉。
 */
export const marksSchema = {
  /**
   * 校验一条标记。
   * @param {unknown} raw 介质里读出来的值。
   * @returns {{ sessionId: string, markedAt: string }} 规整后的记录。
   * @throws {TypeError} 形状不对时抛错，由 domain 层翻成 invalid-record。
   */
  parse(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new TypeError('unread mark must be an object');
    }
    const { sessionId, markedAt } = raw;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('unread mark sessionId must be a non-empty string');
    }
    if (typeof markedAt !== 'string' || markedAt.length === 0) {
      throw new TypeError('unread mark markedAt must be a non-empty string');
    }
    return { sessionId, markedAt };
  },
};

/**
 * domain 声明。形状就是 `defineDomain` 校验的那几个字段，这里直接写字面量而不是
 * 引 `@deepseek-ai/dsh-storage-domain`：那个包在每个 DSH 版本里都在，但插件装
 * 在 profile 里解析到的是 profile 的那一份，和 host 正在跑的那一份未必同一版。
 * 声明是纯数据，让 host 自己校验比绑一个版本更稳。
 */
const DOMAIN = {
  name: DOMAIN_NAME,
  version: 1,
  tables: { [TABLE]: { valueSchema: marksSchema } },
};

/** 认为请求来自本机的地址集合。 */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * 判断连接是否来自本机。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {boolean} 是否本机连接。
 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress;
  return typeof address === 'string' && LOOPBACK_ADDRESSES.has(address);
}

/**
 * 取组合里的 `connection` 服务。
 *
 * 它是**可选**依赖，不能写进 `inject`：没有 client-connection 的 profile 也要能
 * 加载这个插件。cordis 的 `get()` 是显式查表，服务缺席时返回 undefined。
 *
 * @param {object} ctx 主机上下文。
 * @returns {object | undefined} 连接服务。
 */
function connectionOf(ctx) {
  try {
    if (typeof ctx.get === 'function') return ctx.get('connection');
    return Reflect.get(ctx, 'connection');
  } catch {
    return undefined;
  }
}

/**
 * 端点准入判定。
 *
 * 本机连接永远放行；其余来源交给组合的 `connection.requestRejection()`——它做
 * Host/Origin 栅栏与浏览器会话 cookie 校验，和内置插件用的是同一套原语。这个
 * 端点会暴露「哪些会话被标了未读」，是私人阅读状态，不该被同网段的任意页面读走。
 *
 * 返回 `undefined` 表示放行，数字是拒绝状态码。没装 connection 服务的 profile
 * 按「不是本机就拒绝」处理，查表失败、抛错或返回约定之外的值一律 403（fail
 * closed）。
 *
 * @param {object} ctx 主机上下文。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {number | undefined} 拒绝状态码，undefined 表示放行。
 */
export function rejectionFor(ctx, req) {
  if (isLoopback(req)) return undefined;
  const connection = connectionOf(ctx);
  if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') {
    return 403;
  }
  try {
    const rejection = connection.requestRejection(req);
    if (rejection === undefined) return undefined;
    // 不能写成 `?? 403`：那会把「放行」的 undefined 也吃成拒绝。
    return typeof rejection === 'number' ? rejection : 403;
  } catch {
    return 403;
  }
}

/**
 * 回一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {number} status 状态码。
 * @param {unknown} payload 响应体。
 * @param {string} [method] 请求方法；HEAD 只回头不回体。
 */
function sendJson(res, status, payload, method) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  if (method === 'HEAD') res.end();
  else res.end(body);
}

/**
 * 读一个 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {Promise<unknown>} 解析后的值。
 * @throws {Error} 超长、空体或非法 JSON。
 */
export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) throw new Error('empty request body');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 把存储里的记录投影成浏览器半用的字典：`sessionId -> markedAt`。
 * @param {{ entries: () => Iterable<[string, { markedAt: string }]> }} table 标记表。
 * @returns {Record<string, string>} 标记字典。
 */
export function marksToObject(table) {
  const marks = {};
  for (const [key, record] of table.entries()) marks[key] = record.markedAt;
  return marks;
}

/**
 * 装载 host 半。
 * @param {object} ctx cordis host 上下文。
 */
export function apply(ctx) {
  // 没有存储服务就没有可存的地方：整块不装载，而不是退化成内存里的一份假状态。
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['storageDomain'], (storage) => {
    const facility = storage.storageDomain;

    /**
     * 一次打开、单飞复用：卡片、行标记、几个标签页共用同一个 domain；重载时
     * 若上一次还在关，重复 open 会撞 already-open。
     * @returns {Promise<object>} 打开好的 domain。
     */
    let opening;
    const domainOf = () => {
      opening ??= facility.open(DOMAIN).catch((error) => {
        // 失败的 promise 不缓存，否则一次瞬时后端错误会把插件永久钉死。
        opening = undefined;
        throw error;
      });
      return opening;
    };

    // domain 的生命周期归调用方：这一层 effect 是它唯一的关闭点。
    storage.effect(
      () => async () => {
        if (opening === undefined) return;
        try {
          const domain = await opening;
          await domain.close();
        } catch (error) {
          storage.logger?.warn?.(`dsh-unread: closing the domain failed: ${String(error)}`);
        }
      },
      'dsh-unread: domain handle',
    );

    /** 每个打开的 SSE 连接；写入成功后往这里推一次。 */
    const subscribers = new Set();

    /**
     * 把当前全量标记推给所有在线标签页。
     * @param {{ entries: () => Iterable }} table 标记表。
     */
    const broadcast = (table) => {
      if (subscribers.size === 0) return;
      const frame = `event: marks\ndata: ${JSON.stringify({ marks: marksToObject(table) })}\n\n`;
      for (const res of subscribers) {
        try {
          res.write(frame);
        } catch {
          // 半死的连接由 close 事件清理，这里不抢。
        }
      }
    };

    storage.inject(['webServer'], (web) => {
      const server = web.webServer;

      /**
       * 把「拒绝」写成响应；放行时返回 undefined。
       * @param {import('node:http').IncomingMessage} req 请求。
       * @param {import('node:http').ServerResponse} res 响应。
       * @returns {boolean} true 表示已经拒绝并结束。
       */
      const rejected = (req, res) => {
        const status = rejectionFor(storage, req);
        if (status === undefined) return false;
        sendJson(res, status, { ok: false, error: status === 401 ? 'authentication required' : 'forbidden' }, req.method);
        return true;
      };

      // 读全量：卡片、行标记首帧都从这里起步。
      web.effect(
        () =>
          server.register({
            kind: 'exact',
            path: '/plugin/dsh-unread/state',
            handler: async (req, res) => {
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405, { allow: 'GET, HEAD' });
                res.end();
                return;
              }
              if (rejected(req, res)) return;
              try {
                const domain = await domainOf();
                sendJson(res, 200, { ok: true, marks: marksToObject(domain.table(TABLE)) }, req.method);
              } catch (error) {
                sendJson(res, 503, { ok: false, error: `storage unavailable: ${String(error?.message ?? error)}` }, req.method);
              }
            },
          }),
        'dsh-unread: state route',
      );

      // 写一条：唯一的写入口，浏览器半从不本地落状态。
      web.effect(
        () =>
          server.register({
            kind: 'exact',
            path: '/plugin/dsh-unread/mark',
            handler: async (req, res) => {
              if (req.method !== 'POST') {
                res.writeHead(405, { allow: 'POST' });
                res.end();
                return;
              }
              if (rejected(req, res)) return;
              let body;
              try {
                body = await readJson(req);
              } catch (error) {
                sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
                return;
              }
              const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
              if (sessionId.length === 0 || sessionId.length > SESSION_ID_LIMIT) {
                sendJson(res, 400, { ok: false, error: 'sessionId must be a non-empty string' });
                return;
              }
              if (typeof body?.unread !== 'boolean') {
                sendJson(res, 400, { ok: false, error: 'unread must be a boolean' });
                return;
              }
              try {
                const domain = await domainOf();
                const table = domain.table(TABLE);
                if (body.unread) await table.put(sessionId, { sessionId, markedAt: new Date().toISOString() });
                else await table.delete(sessionId);
                // 写成功才推：别让别的标签页先看到一条会回滚的状态。
                broadcast(table);
                sendJson(res, 200, { ok: true, marks: marksToObject(table) });
              } catch (error) {
                sendJson(res, 503, { ok: false, error: `storage unavailable: ${String(error?.message ?? error)}` });
              }
            },
          }),
        'dsh-unread: mark route',
      );

      // SSE：别的浏览器/标签页改了标记，这个标签页立刻跟着变。EventSource 自带
      // cookie，所以准入判定和普通请求走同一套。
      web.effect(
        () =>
          server.register({
            kind: 'exact',
            path: '/plugin/dsh-unread/events',
            handler: (req, res) => {
              if (req.method !== 'GET') {
                res.writeHead(405, { allow: 'GET' });
                res.end();
                return;
              }
              if (rejected(req, res)) return;
              res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
              });
              // 注释帧让代理/浏览器立刻认为流已建立。
              res.write(': connected\n\n');
              subscribers.add(res);
              res.on('close', () => subscribers.delete(res));
              // 连上先补一帧当前状态，省掉一次单独的 state 请求。
              void domainOf()
                .then((domain) => {
                  res.write(`event: marks\ndata: ${JSON.stringify({ marks: marksToObject(domain.table(TABLE)) })}\n\n`);
                })
                .catch(() => {
                  /* 打不开就先空着，后续写入仍会推 */
                });
            },
          }),
        'dsh-unread: events route',
      );

      // 自检端点：安装后先确认 host 半在跑；浏览器半装载时会来打一次卡。
      web.effect(
        () =>
          server.register({
            kind: 'exact',
            path: '/plugin/dsh-unread/health',
            handler: async (req, res) => {
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405, { allow: 'GET, HEAD' });
                res.end();
                return;
              }
              if (rejected(req, res)) return;
              const payload = {
                ok: true,
                plugin: name,
                version,
                domain: DOMAIN_NAME,
                clientSeenAt: lastClientAt ?? null,
              };
              if (typeof req.url === 'string' && req.url.includes('client=1')) lastClientAt = new Date().toISOString();
              sendJson(res, 200, payload, req.method);
            },
          }),
        'dsh-unread: health route',
      );
    });
  });
}

/** 最近一次浏览器半上报的时间戳，用来确认客户端 bundle 真的跑起来了。 */
let lastClientAt;

/** 供测试直接驱动内部原语。 */
export const __internals = {
  DOMAIN,
  DOMAIN_NAME,
  TABLE,
  BODY_LIMIT,
  SESSION_ID_LIMIT,
  marksToObject,
  readJson,
  rejectionFor,
  isLoopback,
};
