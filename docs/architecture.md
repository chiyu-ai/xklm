# 代码结构

三部分：终端固件、服务端、前端。这里说服务端和前端的组织方式，固件见 `firmware/README.md`。

## 服务端 server.js

单文件，约 2400 行，从上到下按职责分了段。没有拆成模块是因为核心状态（`devices`、`conversations`、`queryRecords`）互相引用得比较紧，拆开反而要来回传引用；用文件内的段落注释区分更省事。

### 一、配置与常量

`config.json` + 环境变量合并成一个 `config`。`SPECIES` 从 `species.js` 引入，是静态知识库；`DEFAULT_NORMAL` 是物种表里没定义时的兜底范围。

### 二、状态与持久化

内存里的主状态：

| 变量 | 内容 |
|------|------|
| `devices` | `Map<id, device>`，每台含 `latest`、`history`、`meta` |
| `conversations` | 各对话档案的消息数组 |
| `conversationMeta` | 档案的归属、绑定设备、名称 |
| `queryRecords` | 问答历史，每条带当时的环境快照 |
| `illnessRecords` | 患病记录 |

落盘走一个 `markDirty()` + 定时 `save()` 的简单策略，避免每来一条数据就写盘。文件都在 `data/` 下，都是 JSON（患病和预警另外各存一份 txt 方便直接看）。

### 三、数据接入

`resolveDeviceId()` 认设备 ID，也兼容按 IP 反查。`extractMetrics()` 从请求体里挑出合法的数值字段——非数字、`NaN`、超出物理量程的直接丢掉，不会写进 `latest`。

`upsertDevice()` 做替换而不是合并，但会单独保留 `camera_count`，因为那个字段来自 AI 识别而不是传感器，每秒一次的常规上报里没有它。

### 四、指标判定

三层：

1. `evaluateMetric()` —— 拿 `config.thresholds` 做通用判断，返回 `normal/low/high`
2. `normalFor()` / `stageAdjustedNormal()` —— 取该物种的正常范围，幼年和老年做微调（幼年温度 +2、湿度 +3，老年温度 +1）
3. `severityOf()` —— 判断超出程度，超出量不到范围宽度的 20% 算 `mild`（黄），超过算 `severe`（红）

`deviceSummary()` 把上面三层包起来，输出前端直接能用的结构，包含各项的 `status` 和 `severity`。

### 五、上下文拼装

这是 AI 效果好坏的关键，拆成了几个函数：

- `snapshotEnv(device)` —— 取当前环境快照，存进问答历史用
- `buildEnvironmentContext()` —— 所有在线设备的实时数据
- `buildSpeciesContext(message)` —— 物种知识。**注意它接收 message**：早期只按在线设备的物种取，结果问牛的病时带的是鸡的疫病列表，模型自然想不到牛流行热。现在会从问题里提取物种名一并带上。
- `buildRealKnowledgeContext(message)` —— 本场历史。先由 `pickRelevantQueries()` 从问题里抠物种、设备名、日期（`2026-11-04` 和 `11月4日` 两种写法都认），按条件筛历史记录，筛不到才退回最近几条。
- `buildWeatherContext()` —— 天气，含风险标签（雷暴、大风、低温冰冻、高温热应激等）

拼好的上下文放在提示词最前面，后面才是用户的问题。

### 六、AI 调用

`handleCozeChat()` 处理扣子的流式接口。两个坑：

- `auto_save_history: false` 时必须同时带 `stream: true`，否则接口报参数错误
- 平台偶尔返回 `4028`（额度不足），实测是瞬时限流不是真没额度，所以做了 3 次重试

SSE 解析里要专门处理 `conversation.chat.failed` 事件，不然出错时会返回一段空字符串，看起来像模型没说话。

### 七、结果后处理

`extractDrugs()` 从回答里抓【推荐药品】段，`drugItem()` 生成药品卡（示意图用 SVG data URI 现画，避免外链失效）。`extractCandidates()` 拿回答去和物种表的疫病列表比对，命中就生成病名卡，前端据此暂停等用户确认。

### 八、知识库同步

`recordQuery()` 每次问答后把问题、回答、当时环境写进 `queryRecords`。`syncKnowledgeBase()` 每小时检查当天有没有新记录，有就整理成带分隔符的文档推到扣子知识库——用 `=====` 分段，一条记录一段，这样模型检索时能命中完整的一条而不是半截。加了并发锁，避免启动时和定时器撞车重复上传。

### 九、HTTP 分发

`handleApi()` 里按 `pathname` 逐条 `if` 判断，动态路由用正则取参数。风格上不如路由表优雅，但路径就二十几条，这样改起来最快。

### 十、天气

`getWeather()` 先 `geocodeCity()` 把地名转经纬度再请求 Open-Meteo。`geocodeCity()` 会逐级回退：原名找不到就去掉“区/县”后缀，再找不到就取前两个字。全失败时返回错误，不再静默用配置里的默认坐标——早期就是这么干的，页面显示“重庆渝北区 30°C”，其实是广州的数据。

## 前端

`public/` 下三个文件，没有构建步骤。

`app.js` 按区块组织：

| 区块 | 内容 |
|------|------|
| 工具函数 | `escapeHtml`、`toast`、`renderMarkdown`、`metricLabel`/`metricUnit` |
| 状态 | `devices` Map、`chatHistory`、`currentIndividual` |
| 渲染 | `renderDevices`、`openDetail`、`renderFeedCard`、`openMetricChart` |
| 图表 | `drawChart`、`drawWeatherChart`，直接用 Canvas 2D |
| 交互 | `sendChat`、`startRecognition`、`addCandidateCards`、`addDrugCards` |
| 模块 | 天气、行情、养殖手册、知识库、预警记录、患病记录各自一组函数 |

实时更新走 `EventSource('/api/events')`，收到 `device-updated` 就更新对应设备再重渲染，没有用轮询。

几个状态存在 `localStorage`：`farm-login`（登录态）、`weather-city`（用户设的城市）。城市会被带到 `/api/chat`、`/api/health/:id`、`/api/analysis` 三个请求里，保证 AI 看到的天气和页面上显示的是同一个地方。

静态资源用 `?v=YYYYMMDD` 做版本号，改完前端记得同步改，否则浏览器缓存会导致改了看不到效果。

## 数据文件

```
data/
├── devices.json          设备与历史，historyLimit 控制每台保留条数
├── conversations.json    对话档案
├── conversation-meta.json
├── queries.json          问答历史（含环境快照），保留最近 1000 条
├── illness.json          患病记录
├── illness/*.txt         每次患病一份
├── warnings/*.txt        每次预警一份
└── camera/<id>.jpg       最新快照
```

除 `camera/` 外都是 JSON，直接打开就能看。这些文件不进仓库，分别在各自机器上生成。