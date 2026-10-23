/**
 * dsh-unread —— 浏览器半。
 *
 * 原生会话行只有一个 host 算出来的「未读」（`completionUnread`：这一轮回复你
 * 还没看），既读不到也写不了，更没有「我手动标一下，回头再看」的意思。这一半
 * 补的就是后者：一个由你手动翻转的未读标记，落在侧边栏会话行上。
 *
 * 两个入口，共用一份状态：
 *   1. `sidebar.workspaces.session.menu.item` —— 会话「…」菜单里的一行，
 *      「标为未读 / 标为已读」；
 *   2. `sidebar.session.row.leading` —— 会话标题前那个 16px 单元格里的圆点。
 *      原生只在「没有状态点」时才把这一格让给插件（见 slot 契约），所以这个
 *      圆点永远不会和数据竞争，也不会盖住「运行中 / 等你回答」那些点。
 *
 * 状态在 host 侧（`/plugin/dsh-unread/*`），这里只是它的镜像：读快照、发变更、
 * 订阅 SSE。于是换浏览器、换标签页、重启之后都是同一份，不存在「这台机器上
 * 看着是未读、那台机器上不是」。
 */
window.__ModuleLoader__.load({
	id: "dsh-unread",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		/**
		 * 原生组件库。`MenuItemButton` 就是会话菜单里每一行用的那个按钮（自带
		 * `role="menuitem"`、图标位、`separatorBefore`）；菜单的键盘行走与焦点回归
		 * 靠读 DOM，所以插件行必须用它才落在同一套语义里。
		 */
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/** 文案命名空间。 */
		const NS = "dshUnread";

		/** host 半的三个端点。 */
		const STATE_ENDPOINT = "/plugin/dsh-unread/state";
		const MARK_ENDPOINT = "/plugin/dsh-unread/mark";
		const EVENTS_ENDPOINT = "/plugin/dsh-unread/events";

		//#region 文案
		const zh = {
			"menu.markUnread": "标为未读",
			"menu.markRead": "标为已读",
			"row.unread": "未读",
		};
		const en = {
			"menu.markUnread": "Mark as unread",
			"menu.markRead": "Mark as read",
			"row.unread": "Unread",
		};
		//#endregion

		//#region 样式
		/**
		 * 圆点：居中在那个 16px 单元格里。
		 *
		 * 用 label-secondary 的实心小圆点，而不是四态里的某个颜色——它不是「状态
		 * 异常」，只是「你还没看」；四态色（绿/黄/蓝/红）各有既有含义，借来会误导。
		 * 直径取 6px，和原生状态点的 10px 拉开层级，缩到最小行高也不会顶到标题。
		 *
		 * 圆点由 `::before` 画，所以无障碍树里只有那个 visually-hidden 的「未读」，
		 * 不会被读成「图像 未读 未读」。
		 */
		const CSS = `
.dshUnread_dot{display:inline-flex;align-items:center;justify-content:center;width:16px;height:20px;flex:none;color:var(--dsw-alias-label-secondary)}
.dshUnread_dot::before{content:"";display:block;width:6px;height:6px;border-radius:50%;background:currentColor}
.dshUnread_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}
`;

		/** 样式只装一次；HMR 重复执行 apply 时不会叠出第二个 style 标签。 */
		let stylesInstalled = false;
		function installStyles() {
			if (stylesInstalled) return;
			stylesInstalled = true;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-unread";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region 标记快照
		/**
		 * 会话 id → 标记时间的字典。
		 *
		 * 只有 host 说「是未读」才算未读：这里永远是 host 最近一次给出的全量结果，
		 * 不做本地推断。这样两个浏览器同时改同一条时，最终显示的是宿主那份，而不是
		 * 各自乐观更新的结果。
		 */
		let snapshot = Object.freeze({});

		/** 订阅者集合，`useSyncExternalStore` 的入口。 */
		const listeners = new Set();

		/**
		 * 替换快照并通知。
		 * @param {Record<string, string>} next 新的全量字典。
		 */
		function publish(next) {
			snapshot = Object.freeze(next ?? {});
			for (const listener of listeners) listener();
		}

		/**
		 * 判断某会话是否被标为未读。
		 * @param {string} sessionId 会话 id。
		 * @returns {boolean} 是否未读。
		 */
		function isUnread(sessionId) {
			return typeof sessionId === "string" && Object.hasOwn(snapshot, sessionId);
		}

		/**
		 * 收下端点返回的 `marks`。传进来的就是全量，直接替换。
		 * @param {unknown} marks host 返回的字典。
		 */
		function adopt(marks) {
			if (typeof marks !== "object" || marks === null || Array.isArray(marks)) return;
			/** @type {Record<string, string>} */
			const next = {};
			for (const key of Object.keys(marks)) {
				const value = marks[key];
				if (typeof value === "string") next[key] = value;
			}
			publish(next);
		}

		/**
		 * 拉一次全量状态。失败就保持现状——读不到不等于「都读了」，不能清空。
		 * @returns {Promise<void>} 完成。
		 */
		async function refresh() {
			try {
				const response = await fetch(STATE_ENDPOINT, { cache: "no-store", credentials: "same-origin" });
				if (!response.ok) return;
				const body = await response.json();
				if (body?.ok === true) adopt(body.marks);
			} catch {
				/* 端点缺席或断网：保持上一次的状态 */
			}
		}

		/**
		 * 翻转一条标记，并把 host 的结果收回来。
		 *
		 * 不做乐观更新：一次点击换一次往返，代价只是一行菜单关闭的时间，换来的是
		 * 「显示的永远等于存下的」。
		 *
		 * @param {string} sessionId 会话 id。
		 * @param {boolean} unread true 表示标为未读。
		 * @returns {Promise<boolean>} 是否成功。
		 */
		async function setUnread(sessionId, unread) {
			try {
				const response = await fetch(MARK_ENDPOINT, {
					method: "POST",
					cache: "no-store",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId, unread }),
				});
				if (!response.ok) return false;
				const body = await response.json();
				if (body?.ok !== true) return false;
				adopt(body.marks);
				return true;
			} catch {
				return false;
			}
		}

		/**
		 * 订阅 host 的推送。
		 *
		 * `EventSource` 自带同源 cookie，准入判定和普通请求一致；断线它自己会重连，
		 * 所以这里不写重试逻辑，只把帧交给 {@link adopt}。
		 *
		 * @returns {() => void} 关闭函数。
		 */
		function subscribeEvents() {
			if (typeof EventSource !== "function") return () => {};
			let source;
			try {
				source = new EventSource(EVENTS_ENDPOINT);
			} catch {
				return () => {};
			}
			source.addEventListener("marks", (event) => {
				try {
					const payload = JSON.parse(event.data);
					if (payload?.marks !== undefined) adopt(payload.marks);
				} catch {
					/* 半帧或非法 JSON：丢掉，下一次全量会纠正 */
				}
			});
			return () => {
				try {
					source.close();
				} catch {
					/* 已关闭 */
				}
			};
		}

		/**
		 * 给渲染层用的快照源，形状是 `HostObservable`（`getSnapshot` + `subscribe`）。
		 *
		 * `getSnapshot` 必须返回同一个引用直到真的变化，否则 `useSyncExternalStore`
		 * 会判定为无限更新——这正是快照被冻结、且整块替换的原因。
		 */
		const marksSource = {
			getSnapshot: () => snapshot,
			subscribe(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		};
		//#endregion

		//#region 菜单行
		/**
		 * 「…」菜单里的一行：按当前状态显示「标为未读」或「标为已读」。
		 *
		 * 图标用同一个圆形标记的空心/实心来表达动作结果——空心 = 标完是未读，实心 =
		 * 标完是已读，两行看起来仍是一组，而不是两个不相干的动作。
		 *
		 * @param {object} props slot 注入面 + 行身份 + 文案座。
		 * @returns {import('react').ReactElement} 菜单行。
		 */
		function UnreadMenuItem(props) {
			const { sessionId, useMenuOpenState, useUnread, t } = props;
			const [, setMenuOpen] = useMenuOpenState();
			const unread = useUnread((marks) => Object.hasOwn(marks, sessionId));

			return React.createElement(primitives.MenuItemButton, {
				icon: unread
					? React.createElement(primitives.IconCheckCircleFillRegular, {})
					: React.createElement(primitives.IconCheckCircleOutlineRegular, {}),
				onSelect: () => {
					// 先关菜单：动作是异步的，菜单不该等一个往返。
					setMenuOpen(false);
					void setUnread(sessionId, !unread).catch(() => {});
				},
				children: t(unread ? "menu.markRead" : "menu.markUnread"),
			});
		}
		//#endregion

		//#region 行前圆点
		/**
		 * 会话行标题前的未读圆点。
		 *
		 * 没标未读时不渲染——这一格本来就是空的，占着不放只会把标题挤歪。
		 *
		 * @param {object} props slot 注入面 + 行身份 + 文案座。
		 * @returns {import('react').ReactElement | null} 圆点或空。
		 */
		function UnreadRowDot(props) {
			const { sessionId, useUnread, t } = props;
			const unread = useUnread((marks) => Object.hasOwn(marks, sessionId));
			if (!unread) return null;
			return React.createElement(
				"span",
				{ className: "dshUnread_dot" },
				React.createElement("span", { className: "dshUnread_visuallyHidden", children: t("row.unread") }),
			);
		}
		//#endregion

		//#region 自动已读
		/**
		 * 会话被真正打开时把它标回已读。
		 *
		 * 判据是「当前会话从 A 变成 B」这个**跳变**，而不是「B 现在是当前会话」：
		 * 否则你在正看着的会话上点「标为未读」，会被自己立刻抹掉。跳变意味着你确实
		 * 离开过又回来，那才是「回头再看」的语义终点。
		 *
		 * @param {object} sessions 会话服务（`list` 是快照源）。
		 * @param {(sessionId: string) => boolean} marked 读当前标记的判定。
		 * @returns {() => void} 退订函数。
		 */
		function watchCurrentSession(sessions, marked) {
			/** 上一次看到的当前会话；undefined 表示还没读到过。 */
			let previous;

			const read = () => {
				const list = sessions.list.getSnapshot();
				for (const row of Object.values(list.byId)) {
					if ((row.retainedBy?.mainView ?? 0) > 0) return row.id;
				}
				return undefined;
			};

			const settle = () => {
				const current = read();
				const changed = previous !== undefined && current !== undefined && current !== previous;
				previous = current;
				if (changed && marked(current)) void setUnread(current, false).catch(() => {});
			};

			previous = read();
			return sessions.list.subscribe(settle);
		}
		//#endregion

		/**
		 * 装载浏览器半。
		 * @param {object} ctx 浏览器侧根上下文。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-unread: dictionaries");

			installStyles();

			// 先拉一次全量：首帧就带着正确的圆点，而不是先空一下再跳出来。
			void refresh();
			const stopEvents = subscribeEvents();
			ctx.effect(() => () => stopEvents(), "dsh-unread: event stream");

			// 两个入口共用一个注入面：同名的 `hooks.unread`，渲染层各自绑成 `useUnread`。
			const injected = () => ({ hooks: { unread: marksSource } });

			// order 250：夹在 rename(200) 与 fork(300) 之间——它和 pin 一样是「这条
			// 会话归我管」的阅读状态动作，放在会话身份动作之间最顺。
			ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
				ctx.slots.register(
					{
						name: "sidebar.workspaces.session.menu.item",
						id: "dsh-unread",
						order: 250,
						locale: NS,
						inject: injected,
					},
					UnreadMenuItem,
				),
			);

			// order 20：原生排程标记（ui-schedule）占 10，这个圆点排在它后面。
			ctx.slots.inject("sidebar.session.row.leading", () =>
				ctx.slots.register(
					{
						name: "sidebar.session.row.leading",
						id: "dsh-unread",
						order: 20,
						locale: NS,
						inject: injected,
					},
					UnreadRowDot,
				),
			);

			// 打开会话即回写已读。`sessions` 缺席时只是少了自动已读，手动标记照常。
			ctx.inject(["sessions"], (scoped) => {
				scoped.effect(() => watchCurrentSession(scoped.sessions, isUnread), "dsh-unread: auto-read");
			});

			// 给 host 半打一张卡：服务端能据此确认浏览器半真的跑起来了。
			try {
				void fetch("/plugin/dsh-unread/health?client=1", { cache: "no-store" }).catch(() => {});
			} catch {
				/* 非浏览器环境或路由缺失时静默 */
			}
		}

		exports.UnreadMenuItem = UnreadMenuItem;
		exports.UnreadRowDot = UnreadRowDot;
		exports.apply = apply;
		exports.inject = ["slots", "locale"];
		// 供测试直接驱动内部原语。
		exports.__internals = {
			adopt,
			refresh,
			setUnread,
			isUnread,
			marksSource,
			snapshot: () => snapshot,
			subscribeEvents,
			watchCurrentSession,
			zh,
			en,
			NS,
		};
		return module.exports;
	},
});
