/**
 * 浏览器半的冒烟测试。
 *
 * bundle 是 `window.__ModuleLoader__.load({ id, factory })` 的形状，所以这里用
 * `node:vm` 造一个只有 loader 与最小 DOM 的沙箱：既验证 bundle 能被装载，也验证
 * 它只 require 静态种子里的模块（这是 shell 的硬约束，require 到别的东西就是运行
 * 时白屏）。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const SOURCE = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

/** shell 里可以被 require 的静态种子。 */
const SEED = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]);

/**
 * 一个够用的 React 桩：`createElement` 只记类型与 props，`useSyncExternalStore`
 * 用 `getSnapshot` 直接取值（测试不跑渲染循环，只要拿到当前值）。
 *
 * @returns {object} React 桩。
 */
function fakeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: { ...props, ...(children.length === 1 ? { children: children[0] } : children.length > 1 ? { children } : {}) } };
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      // 条件选择器：`useUnread((marks) => ...)` 的第二个参数就是它的入参。
      return { subscribe, getSnapshot };
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  };
}

/**
 * 装载 bundle，返回它的 exports 与观察点。
 *
 * @param {object} [options] 选项。
 * @param {unknown} [options.fetch] 替换全局 fetch。
 * @param {boolean} [options.eventSource] 是否提供 EventSource。
 * @returns {{ exports: object, styles: object[], requests: object[] }} 结果。
 */
function load({ fetch: fetchImpl, eventSource = false } = {}) {
  /** 记录每一次 fetch：路径 + 选项。 */
  const requests = [];
  /** 记录插进 head 的 style 标签。 */
  const styles = [];

  const document = {
    head: {
      appendChild(node) {
        styles.push(node);
        return node;
      },
    },
    createElement(tag) {
      return { tag, dataset: {}, textContent: '' };
    },
  };

  const sandbox = {
    document,
    console,
    Object,
    JSON,
    Symbol,
    fetch: (url, options) => {
      requests.push({ url: String(url), options });
      return fetchImpl === undefined ? Promise.resolve({ ok: true, json: async () => ({}) }) : fetchImpl(url, options);
    },
  };
  if (eventSource) {
    /** 记录构造出来的流，测试用手推帧。 */
    sandbox.EventSource = class {
      static instances = [];
      listeners = new Map();
      closed = false;
      constructor(url) {
        this.url = url;
        sandbox.EventSource.instances.push(this);
      }
      addEventListener(name, fn) {
        this.listeners.set(name, fn);
      }
      emit(name, data) {
        this.listeners.get(name)?.({ data });
      }
      close() {
        this.closed = true;
      }
    };
  }

  /** 记录 factory 里 require 过的模块。 */
  const required = [];
  let captured;
  sandbox.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        captured = { id, factory };
      },
    },
  };

  vm.createContext(sandbox);
  new vm.Script(SOURCE, { filename: 'lib/client.js' }).runInContext(sandbox);
  assert.ok(captured !== undefined, 'bundle 必须调用 window.__ModuleLoader__.load');
  assert.equal(captured.id, 'dsh-unread');

  const exportObject = captured.factory((specifier) => {
    required.push(specifier);
    if (!SEED.has(specifier)) throw new Error(`bundle 只能 require 静态种子，实际 require 了 ${specifier}`);
    if (specifier === 'react') return fakeReact();
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      /** 记录渲染出来的元素，断言菜单行用的是原生的那一个。 */
      return {
        MenuItemButton: 'MenuItemButton',
        IconCheckCircleOutlineRegular: 'IconCheckCircleOutlineRegular',
        IconCheckCircleFillRegular: 'IconCheckCircleFillRegular',
      };
    }
    throw new Error(`测试桩没有为 ${specifier} 提供实现`);
  });

  return { exports: exportObject, styles, requests, required, sandbox };
}

/**
 * 造一个最小的浏览器 ctx 桩，记下注册的 slot 与字典。
 *
 * @returns {object} ctx 与观察点。
 */
function fakeCtx() {
  const registrations = [];
  const dictionaries = [];
  const effects = new Map();
  const ctx = {
    locale: {
      register(namespace, table) {
        dictionaries.push({ namespace, table });
        return () => {};
      },
    },
    slots: {
      inject(name, factory) {
        const result = factory();
        registrations.push({ name, result });
        return () => {};
      },
      register(options, component) {
        return { options, component };
      },
    },
    effect(fn, label) {
      const result = fn();
      if (typeof result === 'function') effects.set(String(label), result);
      return result;
    },
    inject(deps, callback) {
      if (deps.includes('sessions')) return undefined; // 本测试不装会话服务
      return callback(ctx);
    },
  };
  return { ctx, registrations, dictionaries, effects };
}

test('bundle 只 require 种子模块，并暴露 apply/inject', () => {
  const { exports, required } = load();
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual([...exports.inject], ['slots', 'locale']);
  for (const specifier of required) assert.ok(SEED.has(specifier), specifier);
});

test('apply 注册字典、两个 slot、样式与端点调用', () => {
  const { exports, styles, requests } = load();
  const { ctx, registrations, dictionaries } = fakeCtx();
  exports.apply(ctx);

  assert.deepEqual(
    registrations.map((entry) => entry.name),
    ['sidebar.workspaces.session.menu.item', 'sidebar.session.row.leading'],
  );
  assert.equal(dictionaries.length, 1);
  assert.equal(dictionaries[0].namespace, 'dshUnread');
  assert.equal(dictionaries[0].table.zh['menu.markUnread'], '标为未读');
  assert.equal(dictionaries[0].table.en['menu.markRead'], 'Mark as read');

  assert.equal(styles.length, 1);
  assert.equal(styles[0].dataset.plugin, 'dsh-unread');
  assert.match(styles[0].textContent, /dshUnread_dot/);

  // 启动时拉一次全量、打一次健康卡。
  assert.deepEqual(requests.map((request) => request.url).sort(), [
    '/plugin/dsh-unread/health?client=1',
    '/plugin/dsh-unread/state',
  ]);
});

test('两个 entry 的 order 与 id', () => {
  const { exports } = load();
  const { ctx, registrations } = fakeCtx();
  exports.apply(ctx);

  const [menu, row] = registrations.map((entry) => entry.result.options);
  assert.equal(menu.id, 'dsh-unread');
  assert.equal(menu.order, 250);
  assert.equal(menu.locale, 'dshUnread');
  assert.equal(row.id, 'dsh-unread');
  assert.equal(row.order, 20);
  assert.equal(row.locale, 'dshUnread');

  // 注入面只给 hooks，不额外塞函数：渲染层据此绑出 useUnread。
  assert.deepEqual(Object.keys(registrations[0].result.options.inject()), ['hooks']);
});

/**
 * 比较两份标记字典。
 *
 * 快照里的对象来自 vm 沙箱，原型是本 realm 之外的 `Object.prototype`，严格深比会
 * 因为原型不同而报「结构相同但不是同一个引用」；这里只比值。
 *
 * @param {unknown} actual 实际。
 * @param {unknown} expected 期望。
 */
function assertMarks(actual, expected) {
  assert.deepEqual({ ...actual }, expected);
}

test('adopt 过滤掉非字符串值', () => {
  const { exports } = load();
  const internals = exports.__internals;
  internals.adopt({ a: 'now', b: 3, c: null });
  assertMarks(internals.snapshot(), { a: 'now' });
  assert.equal(internals.isUnread('a'), true);
  assert.equal(internals.isUnread('b'), false);

  // 非对象直接忽略，不该把已有的标记清空。
  internals.adopt(null);
  internals.adopt([1, 2]);
  assertMarks(internals.snapshot(), { a: 'now' });
});

test('refresh 失败时保持现状', async () => {
  const { exports } = load({
    fetch: () => Promise.reject(new Error('offline')),
  });
  const internals = exports.__internals;
  internals.adopt({ a: 'now' });
  await internals.refresh();
  assertMarks(internals.snapshot(), { a: 'now' });
});

test('setUnread 收下 host 返回的全量', async () => {
  const { exports } = load({
    fetch: () => Promise.resolve({ ok: true, json: async () => ({ ok: true, marks: { s1: 'now' } }) }),
  });
  const internals = exports.__internals;
  assert.equal(await internals.setUnread('s1', true), true);
  assert.equal(internals.isUnread('s1'), true);
});

test('setUnread 失败时不动快照、返回 false', async () => {
  const { exports } = load({
    fetch: () => Promise.resolve({ ok: false, json: async () => ({ ok: false }) }),
  });
  const internals = exports.__internals;
  internals.adopt({ s1: 'now' });
  assert.equal(await internals.setUnread('s2', true), false);
  assertMarks(internals.snapshot(), { s1: 'now' });
});

test('菜单行按状态给文案与图标，选中后关菜单并发请求', () => {
  const { exports } = load();
  const { UnreadMenuItem } = exports;

  /** 渲染一次，返回元素与记录下来的菜单动作。 */
  const render = (sessionId) => {
    /** 记录 setMenuOpen 的调用。 */
    const calls = [];
    const props = {
      sessionId,
      t: (key) => key,
      useMenuOpenState: () => [true, (value) => calls.push(value)],
      useUnread: (selector) => selector(exports.__internals.snapshot()),
    };
    return { element: UnreadMenuItem(props), calls };
  };

  exports.__internals.adopt({});
  const unreadRow = render('s1');
  assert.equal(unreadRow.element.type, 'MenuItemButton');
  assert.equal(unreadRow.element.props.children, 'menu.markUnread');
  assert.equal(unreadRow.element.props.icon.type, 'IconCheckCircleOutlineRegular');

  exports.__internals.adopt({ s1: 'now' });
  const readRow = render('s1');
  assert.equal(readRow.element.props.children, 'menu.markRead');
  assert.equal(readRow.element.props.icon.type, 'IconCheckCircleFillRegular');

  // 选中要先把菜单关掉，动作本身是异步的。
  readRow.element.props.onSelect();
  assert.deepEqual(readRow.calls, [false]);
});

test('行前圆点只在标了未读时渲染', () => {
  const { exports } = load();
  const { UnreadRowDot } = exports;
  const props = {
    sessionId: 's1',
    t: (key) => (key === 'row.unread' ? '未读' : key),
    useUnread: (selector) => selector(exports.__internals.snapshot()),
  };

  exports.__internals.adopt({});
  assert.equal(UnreadRowDot(props), null);

  exports.__internals.adopt({ s1: 'now' });
  const element = UnreadRowDot(props);
  assert.equal(element.type, 'span');
  assert.equal(element.props.className, 'dshUnread_dot');
  // 无障碍名只在 visually-hidden 的那一层出现一次。
  assert.equal(element.props.children.props.className, 'dshUnread_visuallyHidden');
  assert.equal(element.props.children.props.children, '未读');
});

test('自动已读只在当前会话跳变时触发', async () => {
  const requests = [];
  const { exports } = load({
    fetch: (url, options) => {
      requests.push({ url, body: options?.body });
      return Promise.resolve({ ok: true, json: async () => ({ ok: true, marks: {} }) });
    },
  });
  const internals = exports.__internals;

  /** 造一个可推的会话列表。 */
  let snapshot = { byId: { a: { id: 'a', retainedBy: { mainView: 1 } } } };
  const subscribers = new Set();
  const sessions = {
    list: {
      getSnapshot: () => snapshot,
      subscribe(fn) {
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      },
    },
  };
  const push = (next) => {
    snapshot = next;
    for (const fn of subscribers) fn();
  };

  internals.adopt({ b: 'now' });
  const stop = internals.watchCurrentSession(sessions, internals.isUnread);

  // 还在 a：没有变化，不发请求。
  push({ byId: { a: { id: 'a', retainedBy: { mainView: 1 } } } });
  assert.equal(requests.length, 0);

  // 切到 b，而 b 恰好是未读：自动回写已读。
  push({ byId: { b: { id: 'b', retainedBy: { mainView: 1 } } } });
  await Promise.resolve();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/plugin/dsh-unread/mark');
  assert.deepEqual(JSON.parse(requests[0].body), { sessionId: 'b', unread: false });

  // 切到没标未读的 c：不发请求。
  push({ byId: { c: { id: 'c', retainedBy: { mainView: 1 } } } });
  await Promise.resolve();
  assert.equal(requests.length, 1);

  stop();
  assert.equal(subscribers.size, 0);
});

test('SSE 帧会更新快照，关闭时断开', () => {
  const { exports, sandbox } = load({ eventSource: true });
  const internals = exports.__internals;
  const stop = internals.subscribeEvents();

  const stream = sandbox.EventSource.instances[0];
  assert.equal(stream.url, '/plugin/dsh-unread/events');

  stream.emit('marks', JSON.stringify({ marks: { s1: 'now' } }));
  assert.equal(internals.isUnread('s1'), true);

  // 坏帧被丢掉，不影响已有状态。
  stream.emit('marks', '{not json');
  assert.equal(internals.isUnread('s1'), true);

  stop();
  assert.equal(stream.closed, true);
});
