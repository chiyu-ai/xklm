# 接口清单

全部接口都在 `server.js` 的 `handleApi()` 里按路径分发，没有用框架，返回一律是 JSON（图片和 SSE 除外）。

统一的返回约定：成功带 `ok: true`，失败带 `ok: false` 和 `error` 文案，HTTP 状态码同步反映。

## 数据上报

### POST /api/data

终端调用的上报入口。`device_id` 必填，其余字段缺省就不更新（不会把缺的写成 0）。

```json
{
  "device_id": "esp32-01",
  "name": "1号鸡舍",
  "temperature": 24.5,
  "humidity": 62,
  "co2": 780,
  "soil": 55,
  "light": 70,
  "flame": 0,
  "feed_level": 35,
  "local_ip": "192.168.1.23",
  "stream_port": 81
}
```

`local_ip` 和 `stream_port` 用于让网页直连板子的 MJPEG 流。上报时会把 `camera_count` 保留下来，不被覆盖。

### GET /api/data/:id

取某台设备的历史数据（最近 `historyLimit` 条）。

## 设备

### GET /api/devices

返回全部设备的汇总：`metrics`（每项带 value / status / severity）、`meta`、`feed`、`normal`（按物种和阶段调整后的范围）、`density`、`history`。

### GET /api/devices/:id

单台设备，结构同上。

### DELETE /api/devices/:id

删除设备。`?chat=delete|keep|archive` 控制它绑定的对话怎么处理，默认 `delete`。

### POST /api/devices/:id/meta

更新设备信息，也可以用来预先建一台没有数据的设备。

```json
{
  "name": "1号鸡舍",
  "species": "鸡",
  "count": 30,
  "area": 20,
  "stage": "成年",
  "weight": 2.5,
  "feed_daily": 3
}
```

`feed_daily` 是每日投喂量（kg），和传感器的 `feed_level` 一起算出剩余比例。`name` 一旦由用户设置过，终端上报就不会再覆盖它。

## 实时推送

### GET /api/events

SSE。事件类型有 `device-updated`、`camera`、`warning` 等，前端据此局部刷新。

## 摄像头

### POST /api/camera/:id

终端上传 JPEG，请求体 `{"data": "<base64>"}`。服务端存到 `data/camera/<id>.jpg`，同时推给所有 SSE 客户端。

### GET /api/camera/:id

返回最新一张 JPEG，没有则 404。

### POST /api/camera/:id/recognize

把画面交给 AI 识别种类和数量。返回里的 `count` 只认模型明确给出的数字，认不出来时是 `null`，同时把 `camera_status` 记进设备 meta。

## AI

### POST /api/chat

```json
{
  "message": "鸡拉绿色稀粪，呼吸有点急，可能是什么病",
  "history": [{ "role": "user", "content": "..." }],
  "images": ["file_id"],
  "individualId": "chicken-03",
  "city": "重庆"
}
```

返回 `reply.content`，以及：

- `drugs` —— 回答里如果有【推荐药品】段，会解析成药品卡（名称、用途、示意图、搜索链接）
- `candidates` —— 识别到的候选病种，每项带病名、典型症状、示意图、图片搜索链接
- `pendingConfirm` —— 为 true 时前端会暂停，等用户确认病名再继续

`city` 用来取当地天气，不传就按配置里的默认城市。

### POST /api/health/:id

生成健康预警。返回预警正文、当时的天气、摄像头状态，同时把正文写到 `data/warnings/`。

请求体可带 `{"city": "..."}`。

### GET /api/warnings

预警记录列表（文件名、时间、设备）。

### GET /api/warnings/file?name=xxx

读某一条预警的全文。

### DELETE /api/warnings/file?name=xxx

删除某一条。

## 知识

### GET /api/real-knowledge

聚合出来的本场知识库：按病种统计的 `parameters`（出现次数、平均温湿度、常见症状）、`records`（患病记录）、`queries`（问答历史含环境快照）。

### DELETE /api/queries/:id

删掉一条问答历史。

### POST /api/kb/sync

手动把当天记录同步到扣子知识库。平时是每小时自动跑一次。

## 患病记录

### POST /api/illness

```json
{
  "individualId": "chicken-03",
  "deviceId": "esp32-01",
  "disease": "新城疫",
  "symptoms": "拉绿色稀粪、呼吸困难"
}
```

会自动抓取当时的设备环境一起存下来，并单独生成一个 txt。

### GET /api/illness

列表。

### DELETE /api/illness/:id

删除。

## 对话档案

### GET /api/conversations

返回 `{id, name, bound, deviceId, count, lastTs}`，主对话排在最前。

### GET /api/conversations/:id

读某个档案的完整消息。

### POST /api/conversations/:id

追加消息。

### DELETE /api/conversations/:id

删除。`main` 主对话只清空不删；绑定设备的档案不能删（返回 403）。

## 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/species` | 物种知识库全量 |
| GET | `/api/analysis?city=` | 环境对比分析，含天气与风险提示 |
| GET | `/api/weather?city=` | 天气（当前 + 逐时 + 逐日 + 空气质量 + 农事建议） |
| GET | `/api/market` | 行情 |
| GET | `/api/market/breeds` | 品种行情 |
| POST | `/api/login` | 登录校验 |
| GET | `/api/config` | 前端需要的配置（不含密钥） |
| GET | `/api/health` | 服务存活检查 |
| POST | `/api/upload` | 上传图片给多模态模型用 |

天气数据来自 Open-Meteo 的免费接口，不需要 key。地名查不到时会逐级回退（去掉“区/县”后缀，再取前两个字），实在找不到就明确返回错误，不会拿默认坐标的数据冒充。