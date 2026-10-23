# dsh-unread

DSH 插件：**手动把会话标为未读**。会话「…」菜单里多一行开关，侧边栏会话行前多一个圆点；标记存在 host 侧，换浏览器、换标签页、重启之后都是同一份。

## 它补的是什么

DSH 原生只有一个「未读」（`completionUnread`）：host 按模型完成事件算出「这一轮回复你还没看」，浏览器半既读不到也写不了。它描述的是一段回复的新旧，不是「我手动标一下，回头再看」的待办。

这个插件补的是后者：一个由你手动翻转的未读标记，落在侧边栏会话行上。

- **会话菜单**：`sidebar.workspaces.session.menu.item` 加一行「标为未读 / 标为已读」；
- **会话行圆点**：`sidebar.session.row.leading` 里画一个 6px 圆点。原生只在没有状态点时才把这一格让给插件，所以它不会和数据竞争，也不会盖住「运行中 / 等你回答」那些点；
- **自动已读**：打开某个会话时，若它被标了未读，会自动清掉。

## 状态在哪

状态不在 localStorage，而在 DSH 的 domain 存储里（`ctx.storageDomain`，domain `dsh_unread`，表 `marks`）。浏览器半只读快照、发变更，写入永远回到 host。

于是同一台 host 上的不同浏览器、不同标签页看到的是同一份状态；host 重启后标记还在。

## 端点

host 半注册四个端点：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/plugin/dsh-unread/state` | 读全量标记 |
| `POST` | `/plugin/dsh-unread/mark` | 翻转一条标记 `{ id, unread }` |
| `GET` | `/plugin/dsh-unread/events` | SSE，把其他标签页的变更推过来 |
| `GET` | `/plugin/dsh-unread/health` | 安装自检；浏览器半装载后会打一次卡 |

非本机连接在没有 `connection` 服务时一律 403；有 `connection` 时按它自己的判定走。

依赖保持可选：组合里没有 `storage-domain` 就整块不装载（没有可存的地方），没有 `webServer` 就少端点。两种情况都不抛错。

## 安装

在 DSH Web 的插件页 → 添加插件：

```
github:RWDai/dsh-unread
```

或本地开发：

```
link:/path/to/dsh-unread
```

也可以直接装包含它的组合包：`github:RWDai/dsh-rwdai-bundle`。

## 测试

```bash
npm test
```

host 半与浏览器半各有一份不依赖 DSH 运行时的冒烟测试：host 用最小 cordis ctx 桩真发请求打四个端点；浏览器半用 `node:vm` 造 loader 与最小 DOM，验证 bundle 形状、slot 注册、SSE 与快照更新。

## 许可

MIT
