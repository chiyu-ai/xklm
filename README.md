# 养殖环境监测与辅助诊断系统

一套自己搭的畜禽舍监测系统。终端是一块 ESP32-S3 摄像头开发板，挂了温湿度、二氧化碳、土壤、光照、火焰、饲料槽重量几路传感器，每秒把数据推到云服务器；网页上看实时数值、历史曲线和摄像头画面，也能把环境数据丢给 AI 做疾病辅助诊断。

做这个东西的起因很直接——家里养鸡，夏天热死过一批，平时靠感觉通风、凭经验判断病，往往等到鸡不吃食了才发现问题。就想着做一套能 24 小时自己盯着的设备，出了偏差先报警，而不是等人发现。

## 目录

- [功能](#功能)
- [技术架构](#技术架构)
- [仓库结构](#仓库结构)
- [跑起来](#跑起来)
- [配置](#配置)
- [硬件](#硬件)
- [接口](#接口)
- [部署](#部署)
- [踩过的坑](#踩过的坑)
- [已知问题](#已知问题)
- [团队](#团队)
- [许可](#许可)

## 功能

**环境监测**

温度、湿度、二氧化碳、土壤湿度、光照、火焰、饲料槽余量，默认 1 秒采集一次、1 秒上报一次。每项指标按设备上填的物种和成长阶段取对应正常范围，超出分两档显示：轻微超出标黄，超出较多标红。点指标可以看历史曲线，图上带正常范围底色。

多台设备分开管理，每台可以填物种、品种、数量、面积、成长阶段、体重，系统自动算种群密度，并和该物种的推荐密度对比。

**摄像头**

板子在 81 端口自己跑一个 MJPEG 流，同一个局域网里浏览器直连，延迟基本感觉不到。外网访问时用服务器上的快照兜底，板子每秒推一张 JPEG 上去。页面上可以开 AI 识别，判断画面里有多少只、什么状态。

**AI 辅助诊断**

聊天框里描述症状，服务端会把当前环境数据、本场历史记录、该物种的常见疫病和当地天气一起塞进提示词，再交给扣子（Coze）的智能体。判完先跳出一张病名卡（点开是真实症状的图片搜索），你自己确认是哪个病，它再往下给防治方案——这样避免它一上来就猜个病然后顺着编。

每台设备有独立的对话档案，复诊时会自动带上既往记录。健康预警和患病记录都按文本落盘，页面上能查、能加、能删。

**其他**

养殖手册收了 34 类物种、2933 个品种，先选物种再选品种两级浏览，支持模糊搜索。另有市场行情和天气预报（城市可以自己搜）。

## 技术架构

| 层 | 用什么 |
|----|--------|
| 终端 | ESP32-S3 N16R8、Arduino 框架、OV3660 摄像头、DHT11、JW01 二氧化碳、RFP602 压力膜、SSD1306 OLED |
| 服务端 | Node.js 18+，**零第三方依赖**，只用 `http` / `fs` / `path` / `url` 等内置模块 |
| 前端 | 原生 HTML + CSS + JavaScript，图表用 Canvas 手绘，无框架无构建步骤 |
| 通信 | HTTP（数据上报、快照）、SSE（实时推送）、MJPEG（视频流） |
| AI | 扣子 Coze v3 Chat API |

服务端不装任何 npm 包，是刻意的：把整个目录拷到服务器、`node server.js` 就能跑，评审环境也不用等依赖安装。前端同理，改完刷新就生效。

数据流：

```
传感器 ──HTTP POST /api/data──▶ 内存 devices ──▶ data/devices.json
                                    │
                              SSE /api/events
                                    │
浏览器 ◀─────────────────────────────┘

摄像头 ──JPEG──▶ /api/camera/:id ──▶ data/camera/<id>.jpg
        或局域网直连 http://<板子IP>:81/stream

提问 ──▶ /api/chat ──▶ 拼上下文 ──▶ 扣子 API ──▶ 回答
              （实时环境 + 历史记录 + 物种知识 + 天气）

每次问答 ──▶ data/queries.json ──▶ 每小时汇总同步到扣子知识库
```

上下文不是每次全量塞。服务端会先从问题里抠出物种名、设备名、日期（`11月4日` 和 `2026-11-04` 两种写法都认），再按这些条件从历史记录里挑相关的几条带上去，挑不到才退回最近的几条。这样问"11 月 2 号那头猪怎么样"时，带的就是那一天那一头猪的记录，而不是最近几条鸡的。

## 仓库结构

```
farm-monitor/
├── server.js                  服务端全部逻辑，约 2400 行，按功能分段
├── species.js                 物种与品种知识库（34 类 / 2933 个品种）
├── market.js                  行情数据生成
├── public/
│   ├── index.html
│   ├── app.js                 前端逻辑
│   └── style.css
├── firmware/
│   └── esp32_s3_farm_camera/
│       ├── esp32_s3_farm_camera.ino
│       └── README.md          接线图、烧录参数、传感器标定
├── docs/
│   ├── architecture.md        模块划分与关键函数
│   ├── api.md                 接口清单
│   └── hardware.md            硬件清单与接线
├── deploy/
│   ├── install.sh             一键部署到 systemd
│   ├── farm-monitor.service
│   └── DEPLOY.md
├── config.example.json        配置模板
├── .env.example               环境变量模板
└── package.json
```

运行时才产生的目录（已在 `.gitignore` 里排除）：

```
data/
├── devices.json          设备数据与历史
├── conversations.json    各设备的对话档案
├── illness.json          患病记录
├── illness/              每次患病一个 txt
├── warnings/             每次 AI 预警一个 txt
├── camera/               最新快照
└── queries.json          问答历史（含当时的环境快照）
```

## 跑起来

需要 Node.js 18 或以上（用到了内置 `fetch`），没有别的依赖。

```bash
git clone <仓库地址>
cd farm-monitor

cp config.example.json config.json     # 填账号、智能体密钥等
node server.js
```

浏览器打开 `http://localhost:3000`，默认账号 `1`、密码 `1`（在 `config.json` 的 `auth` 里改）。

没有硬件也能看效果——`curl` 打一条模拟数据就行：

```bash
curl -X POST http://localhost:3000/api/data \
  -H "Content-Type: application/json" \
  -d '{"device_id":"esp32-01","name":"1号鸡舍","temperature":24.5,"humidity":62,"co2":780,"soil":55,"light":70,"flame":0,"feed_level":35}'
```

多打几次，页面上曲线、告警、密度对比就都出来了。

## 配置

配置优先级：环境变量 > `config.json` > 代码内默认值。密钥建议走环境变量，别写进文件。

```bash
cp .env.example .env
```

| 变量 | 作用 |
|------|------|
| `PORT` | 服务端口，默认 3000 |
| `HOST` | 监听地址，默认 0.0.0.0 |
| `COZE_API_KEY` | 扣子 API Token，覆盖 `agent.apiKey` |
| `COZE_BOT_ID` | 扣子 Bot ID，覆盖 `agent.botId` |
| `WEATHER_CITY` | 默认天气城市 |

`config.json` 里几个容易改错的地方：

- `thresholds` —— 通用告警阈值。真正生效的是物种表里的范围，这里只是兜底。
- `agent` —— 智能体。`type` 留 `coze` 走扣子；要换别的模型就填 `apiUrl`，服务端会直接转发。
- `knowledgeBase.dataset_id` —— 扣子知识库 ID，填了并置 `auto: true` 才会每小时自动同步历史记录。
- `offlineAfterMs` —— 多久没上报算离线，默认 120 秒。

依赖清单：服务端无第三方 npm 依赖（见 `package.json`）；固件需要 DHT sensor library、Adafruit Unified Sensor、Adafruit SSD1306、Adafruit GFX Library，esp32-camera 随 ESP32 Arduino 核心提供。

## 硬件

| 模块 | 接线 |
|------|------|
| DHT11 温湿度 | DATA → GPIO47 |
| 土壤湿度 | AO → GPIO1 |
| 光敏 | AO → GPIO3 |
| 火焰 | DO → GPIO21 |
| JW01 二氧化碳 | B(TX) → GPIO14，9600 8N1 |
| RFP602 压力膜 | AO → GPIO2（需 10kΩ 分压） |
| OLED | SDA → GPIO41，SCL → GPIO42 |
| OV3660 摄像头 | 板载 FPC，不用接 |

细节、供电要求和 Arduino 编译参数见 [`docs/hardware.md`](docs/hardware.md) 和 [`firmware/esp32_s3_farm_camera/README.md`](firmware/esp32_s3_farm_camera/README.md)。

选脚上有两点要注意，都是被坑过的：ESP32-S3 开 WiFi 之后 ADC2 全部不可用，模拟量只能走 ADC1（GPIO1–10），而这块板的 4–10 全给了摄像头，所以能用的只剩 1、2、3；另外 GPIO48 是板载 WS2812 彩灯，接别的信号会把灯点亮。

## 接口

完整清单带参数说明见 [`docs/api.md`](docs/api.md)。常用的几个：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/data` | 终端上报环境数据 |
| GET | `/api/devices` | 全部设备及最新值 |
| GET | `/api/events` | SSE 实时推送 |
| POST | `/api/devices/:id/meta` | 更新物种、数量、面积、阶段、体重、每日投喂量 |
| POST | `/api/camera/:id` | 上传快照 |
| POST | `/api/camera/:id/recognize` | AI 识别画面 |
| POST | `/api/health/:id` | 生成健康预警 |
| POST | `/api/chat` | 与智能体对话 |
| GET | `/api/analysis` | 环境对比分析 |
| GET | `/api/weather?city=` | 天气 |
| GET | `/api/market` | 行情 |

## 部署

Linux 服务器上跑：

```bash
sudo bash deploy/install.sh /opt/farm-monitor
```

脚本会复制文件、建 `data/` 目录、写 systemd 单元并拉起服务。手动部署和 Nginx 反代见 [`deploy/DEPLOY.md`](deploy/DEPLOY.md)。

## 踩过的坑

留个记录，免得以后重复犯。

**DHT11 每秒读一次会一直失败。** 一开始按 1 秒读，串口全是读取失败，但 OLED 上还有数字——因为 OLED 显示的是上一次成功读到的缓存值，看着像正常。后来把间隔放到 2.5 秒、每次失败重试 3 次才稳定。DHT11 手册写的两次读取间隔要 ≥2 秒，是真事。

**读不到就不发，别发 0。** 最早读失败时代码把温度写成 0 一起上报，网页上就显示 0°C，看起来像传感器坏了。改成读失败时不带这两个字段，前端显示“—”，一眼能看出是没数据而不是数据异常。

**摄像头计数会被传感器数据冲掉。** 每秒上报的环境数据会整体替换 `latest`，AI 识别出来的数量夹在里面一起没了。现在替换时会把 `camera_count` 单独保留下来。

**AI 数不准会乱报。** 早期识别空白画面也会给出“3 只”这种答案。现在要求模型必须输出固定格式，认不出来就返回 `数量：未知`，前端不存这个数。

**天气地名查不到会静默用默认坐标。** 搜“重庆渝北区”时气象库没有这个地名，服务端没报错，直接用配置里的广州坐标，页面上还显示着“重庆渝北区”——30 度的重庆十一月，看着就不对。现在地名逐级回退（去掉“区”→取前两个字），实在找不到就明确提示，不再拿别的地方的数据冒充。

**AI 判病只按在线设备取物种知识。** 设备是鸡舍，问牛的病，提示词里带的却是鸡的疫病列表，模型自然想不到牛流行热。现在会从提问里提取物种名，一并带进去。

## 已知问题

- 二氧化碳模块的接线对接触比较敏感，松一点就收不到数据，串口会一直没帧。
- RFP602 是压力膜不是称重传感器，测出来的是相对余量百分比，需要先用空槽和满槽标定，不能直接给公斤数。标定值存 NVS，断电不丢。
- 饲料槽的判断规则是“次日剩余超过 20% 说明采食不足”，前提是每天按量投喂一次。投一次管几天的用法下这个规则不成立。
- 市场行情目前是本地按品种生成的价格模型，不是真实行情，接真实数据源要改 `market.js`。
- 前端没有做打包和压缩，`app.js` 有 86 KB，首屏在慢网下会顿一下。

## 团队

| 项 | 内容 |
|----|------|
| 团队名称 | 小卡了米 |
| 队长 | 段祖铭 |
| 成员 | 谭博文 |
| 指导教师 | 张娅玲、赵长春 |
| 联系方式 | 15282800230 |

## 许可

MIT，见 [LICENSE](LICENSE)。