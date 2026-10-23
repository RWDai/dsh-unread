/**
 * host 半的冒烟测试：不依赖 DSH 运行时，用一个最小的 cordis ctx 桩把插件装起来，
 * 然后真的发请求打端点。
 *
 * 覆盖的是「装不上 / 装上了但端点不对」这两类最容易在安装时才发现的问题：
 * 插件形状、依赖声明、四个路由、准入判定、翻转语义、体校验。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __internals, apply, inject, marksSchema, name } from '../lib/index.js';

/**
 * 造一个最小的 host ctx 桩。
 *
 * 只要 `inject(deps, cb)` 与 `effect(fn)` 两个原语：`inject` 立刻用桩里的服务回调，
 * `effect` 立刻执行并收集 disposer——这足以覆盖插件自己会用到的那部分生命周期。
 *
 * @param {Record<string, unknown>} services 可用服务表。
 * @returns {{ ctx: object, effects: Map<string, () => unknown> }} 桩与观察点。
 */
function fakeCtx(services) {
  /** 按 effect 标签收集 disposer，测试才能精确地只关某一层。 */
  const effects = new Map();

  const make = (own) => {
    const scoped = {
      ...own,
      effect(fn, label) {
        const result = fn();
        if (typeof result === 'function') effects.set(String(label), result);
        return result;
      },
      inject(deps, callback) {
        const missing = deps.filter((dep) => own[dep] === undefined);
        if (missing.length > 0) return undefined;
        return callback(scoped);
      },
    };
    return scoped;
  };

  return { ctx: make(services), effects };
}

/**
 * 造一个 storageDomain 桩：一张内存表，写入即生效。
 *
 * `close` 照真实 `Domain.close()` 的契约做成幂等——真实实现里重复关闭共享同一个
 * teardown，桩也必须如此，否则测试会去测桩自己的计数而不是插件的关闭路径。
 *
 * @returns {{ facility: object, closed: () => number }} 服务与关闭计数。
 */
function fakeStorageDomain() {
  const records = new Map();
  let closes = 0;
  const table = {
    get: (key) => records.get(key),
    entries: () => [...records.entries()][Symbol.iterator](),
    keys: () => [...records.keys()][Symbol.iterator](),
    get size() {
      return records.size;
    },
    async put(key, value) {
      records.set(key, value);
    },
    async delete(key) {
      return records.delete(key);
    },
    async update(key, fn) {
      const next = fn(records.get(key));
      records.set(key, next);
      return next;
    },
  };
  let closed = false;
  const domain = {
    table: () => table,
    close: async () => {
      if (closed) return;
      closed = true;
      closes += 1;
    },
  };
  return {
    facility: { open: async (spec) => (assert.equal(spec.name, __internals.DOMAIN_NAME), domain) },
    closed: () => closes,
  };
}

/**
 * 造一个 webServer 桩：`register` 记下路由，返回 disposer。
 *
 * @param {Map<string, object>} routes 路由表。
 * @returns {object} 服务。
 */
function fakeWebServer(routes) {
  return {
    register: (route) => {
      assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
}

/**
 * 造一个可读的请求对象。
 *
 * @param {object} [options] 选项。
 * @param {string} [options.method] 方法。
 * @param {unknown} [options.body] 请求体（会被 JSON 序列化）。
 * @param {string} [options.address] 对端地址。
 * @param {string} [options.url] URL。
 * @returns {object} 请求。
 */
function fakeRequest({ method = 'GET', body, address = '127.0.0.1', url = '/' } = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const chunks = text === '' ? [] : [Buffer.from(text, 'utf8')];
  return {
    method,
    url,
    headers: {},
    socket: { remoteAddress: address },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/**
 * 造一个记录响应的响应对象。
 *
 * @returns {object} 响应，带 `status`/`payload`/`ended` 观察点。
 */
function fakeResponse() {
  const response = {
    status: undefined,
    headers: undefined,
    body: '',
    ended: false,
    writeHead(status, headers) {
      response.status = status;
      response.headers = headers;
    },
    write(chunk) {
      response.body += chunk;
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) response.body += chunk;
      response.ended = true;
    },
    get json() {
      return response.body === '' ? undefined : JSON.parse(response.body);
    },
  };
  return response;
}

/**
 * 装起插件并返回路由表。
 *
 * @param {object} [options] 选项。
 * @param {string} [options.address] 请求对端地址。
 * @returns {{ routes: Map<string, object>, storage: object, effects: Map<string, () => unknown> }} 环境。
 */
function boot() {
  const store = fakeStorageDomain();
  const routes = new Map();
  const { ctx, effects } = fakeCtx({
    storageDomain: store.facility,
    webServer: fakeWebServer(routes),
  });
  apply(ctx);
  // 路由是在 storageDomain 的 inject 回调里注册的，同步完成；不需要等。
  assert.equal(routes.size, 4);
  return { routes, storage: store, effects };
}

test('插件形状：名字、依赖、apply', () => {
  assert.equal(name, 'dsh-unread');
  assert.deepEqual(inject, []);
  assert.equal(typeof apply, 'function');
});

test('装出四个端点', () => {
  const { routes } = boot();
  assert.deepEqual(
    [...routes.keys()].sort(),
    ['/plugin/dsh-unread/events', '/plugin/dsh-unread/health', '/plugin/dsh-unread/mark', '/plugin/dsh-unread/state'],
  );
  for (const route of routes.values()) assert.equal(route.kind, 'exact');
});

test('GET /state 从空开始，POST /mark 翻转后立刻可读', async () => {
  const { routes } = boot();
  const state = routes.get('/plugin/dsh-unread/state');

  const first = fakeResponse();
  await state.handler(fakeRequest(), first);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { ok: true, marks: {} });

  const mark = routes.get('/plugin/dsh-unread/mark');
  const written = fakeResponse();
  await mark.handler(fakeRequest({ method: 'POST', body: { sessionId: 's-1', unread: true } }), written);
  assert.equal(written.status, 200);
  assert.equal(written.json.ok, true);
  assert.equal(typeof written.json.marks['s-1'], 'string');

  const second = fakeResponse();
  await state.handler(fakeRequest(), second);
  assert.deepEqual(Object.keys(second.json.marks), ['s-1']);

  // 再标一次已读：记录消失，返回的全量里也没有它了。
  const cleared = fakeResponse();
  await mark.handler(fakeRequest({ method: 'POST', body: { sessionId: 's-1', unread: false } }), cleared);
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.json.marks, {});
});

test('POST /mark 的体校验', async () => {
  const { routes } = boot();
  const mark = routes.get('/plugin/dsh-unread/mark');

  /** 发一个体、拿回状态码。 */
  const post = async (body) => {
    const res = fakeResponse();
    await mark.handler(fakeRequest({ method: 'POST', body }), res);
    return res.status;
  };

  assert.equal(await post({ sessionId: '', unread: true }), 400);
  assert.equal(await post({ sessionId: '   ', unread: true }), 400);
  assert.equal(await post({ sessionId: 's', unread: 'yes' }), 400);
  assert.equal(await post({ sessionId: 'x'.repeat(__internals.SESSION_ID_LIMIT + 1), unread: true }), 400);
  assert.equal(await post({}), 400);
});

test('方法不对回 405', async () => {
  const { routes } = boot();
  for (const [path, method] of [
    ['/plugin/dsh-unread/state', 'POST'],
    ['/plugin/dsh-unread/mark', 'GET'],
    ['/plugin/dsh-unread/health', 'POST'],
    ['/plugin/dsh-unread/events', 'POST'],
  ]) {
    const res = fakeResponse();
    await routes.get(path).handler(fakeRequest({ method }), res);
    assert.equal(res.status, 405, `${method} ${path}`);
  }
});

test('非本机连接没有 connection 服务时一律 403', async () => {
  const { routes } = boot();
  const res = fakeResponse();
  await routes.get('/plugin/dsh-unread/state').handler(fakeRequest({ address: '192.168.0.9' }), res);
  assert.equal(res.status, 403);
  assert.equal(res.json.ok, false);
});

test('rejectionFor：本机放行、connection 的判定被原样采用', () => {
  const allowed = fakeCtx({ connection: { requestRejection: () => undefined } }).ctx;
  assert.equal(__internals.rejectionFor(allowed, fakeRequest({ address: '10.0.0.4' })), undefined);
  assert.equal(__internals.rejectionFor(allowed, fakeRequest({ address: '127.0.0.1' })), undefined);

  const denied = fakeCtx({ connection: { requestRejection: () => 401 } }).ctx;
  assert.equal(__internals.rejectionFor(denied, fakeRequest({ address: '10.0.0.4' })), 401);

  // 返回约定之外的值不能当成放行。
  const weird = fakeCtx({ connection: { requestRejection: () => false } }).ctx;
  assert.equal(__internals.rejectionFor(weird, fakeRequest({ address: '10.0.0.4' })), 403);

  // 抛错同样 fail closed。
  const throwing = fakeCtx({
    connection: {
      requestRejection: () => {
        throw new Error('boom');
      },
    },
  }).ctx;
  assert.equal(__internals.rejectionFor(throwing, fakeRequest({ address: '10.0.0.4' })), 403);
});

test('标记 schema 拒绝空 id 与非对象', () => {
  assert.deepEqual(marksSchema.parse({ sessionId: 's', markedAt: 'now' }), { sessionId: 's', markedAt: 'now' });
  assert.throws(() => marksSchema.parse({ sessionId: '', markedAt: 'now' }), /sessionId/);
  assert.throws(() => marksSchema.parse({ sessionId: 's' }), /markedAt/);
  assert.throws(() => marksSchema.parse(null), /object/);
  assert.throws(() => marksSchema.parse([]), /object/);
});

test('读不到存储时回 503，而不是假装成功', async () => {
  const routes = new Map();
  const failing = {
    open: async () => {
      throw new Error('backend down');
    },
  };
  const { ctx } = fakeCtx({ storageDomain: failing, webServer: fakeWebServer(routes) });
  apply(ctx);
  const res = fakeResponse();
  await routes.get('/plugin/dsh-unread/state').handler(fakeRequest(), res);
  assert.equal(res.status, 503);
  assert.match(res.json.error, /backend down/);
});

test('关闭时把 domain 关掉，且只关一次', async () => {
  const { routes, storage, effects } = boot();

  // 先真的用一次，让 domain 被打开；关闭必须落在那个已经打开的句柄上。
  const res = fakeResponse();
  await routes.get('/plugin/dsh-unread/state').handler(fakeRequest(), res);
  assert.equal(res.status, 200);
  assert.equal(storage.closed(), 0);

  const dispose = effects.get('dsh-unread: domain handle');
  assert.equal(typeof dispose, 'function');
  await dispose();
  assert.equal(storage.closed(), 1);

  // 已经关掉之后再关一次：幂等，不该再关一遍底下的 domain。
  await dispose();
  assert.equal(storage.closed(), 1);
});
