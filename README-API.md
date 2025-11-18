# HTTP API 桥接服务使用说明

## 概述

HTTP API 桥接服务是一个简单的替代方案，避免 MQTT 连接问题。设备直接通过 HTTP POST 请求发送对话统计到桥接服务。

## 优势

- ✅ 无需 MQTT 连接
- ✅ 更简单可靠
- ✅ 支持本地存储
- ✅ 提供 RESTful API

## 使用方法

### 1. 启动桥接服务

```bash
cd bridge
./start-api.sh
```

### 2. 配置设备端

在设备端配置统计 API URL。可以通过以下方式：

#### 方式 A: 使用 menuconfig 配置

```bash
idf.py menuconfig
```

在配置中找到 `Stats API URL`，设置为：
```
http://your-server-ip:3000/api/conversation-stats
```

#### 方式 B: 修改代码

在 `main/protocols/protocol.cc` 中，`CONFIG_STATS_API_URL` 默认为空。如果需要，可以：

1. 在 `sdkconfig` 中添加：
   ```
   CONFIG_STATS_API_URL="http://your-server-ip:3000/api/conversation-stats"
   ```

2. 或者在代码中硬编码（不推荐）

### 3. 设备端代码修改

设备端代码已经支持 HTTP POST 发送。只需要配置 `CONFIG_STATS_API_URL` 即可。

## API 端点

### POST /api/conversation-stats

接收设备发送的对话统计。

**请求体：**
```json
{
  "session_id": "abc123",
  "duration": 10.5,
  "reason": "tts_stop",
  "timestamp": 1234567890
}
```

**响应：**
```json
{
  "success": true,
  "message": "Conversation stats received",
  "conversation": {
    "sessionId": "abc123",
    "duration": 10.5,
    "reason": "tts_stop",
    "timestamp": 1234567890,
    "receivedAt": 1234567890123
  }
}
```

### GET /api/conversations

获取所有对话统计。

**查询参数：**
- `limit` - 返回数量限制（默认：100）
- `offset` - 偏移量（默认：0）

**响应：**
```json
{
  "success": true,
  "total": 50,
  "conversations": [...],
  "stats": {
    "totalConversations": 50,
    "totalDuration": 500.5,
    "averageDuration": 10.01
  }
}
```

### GET /api/stats

获取统计摘要。

**响应：**
```json
{
  "success": true,
  "stats": {
    "totalConversations": 50,
    "totalDuration": 500.5,
    "averageDuration": 10.01,
    "maxDuration": 30.5,
    "websocketClients": 1,
    "apiRequests": 50
  },
  "conversations": [...] // 最近10条
}
```

### DELETE /api/conversations

清空所有对话统计。

**响应：**
```json
{
  "success": true,
  "message": "All conversations cleared"
}
```

## WebSocket 连接

前端页面可以连接到 WebSocket 服务器：

```javascript
const ws = new WebSocket('ws://localhost:8080');
ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'conversation_stats') {
        // 处理对话统计
    }
};
```

## 数据存储

对话统计会自动保存到 `conversations.json` 文件，服务重启后会自动加载。

## 测试

### 使用 curl 测试

```bash
# 发送对话统计
curl -X POST http://localhost:3000/api/conversation-stats \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "test-123",
    "duration": 10.5,
    "reason": "test",
    "timestamp": 1234567890
  }'

# 获取所有对话
curl http://localhost:3000/api/conversations

# 获取统计摘要
curl http://localhost:3000/api/stats
```

## 配置说明

### 环境变量

- `WS_PORT` - WebSocket 端口（默认：8080）
- `HTTP_PORT` - HTTP API 端口（默认：3000）

### 设备端配置

在 `sdkconfig` 中配置：

```
CONFIG_STATS_API_URL="http://your-server-ip:3000/api/conversation-stats"
```

## 与 MQTT 方案对比

| 特性 | HTTP API | MQTT |
|------|----------|------|
| 连接复杂度 | 简单 | 复杂 |
| 实时性 | 轮询/推送 | 实时推送 |
| 可靠性 | 高 | 中等 |
| 配置难度 | 低 | 高 |
| 服务器要求 | 低 | 需要 MQTT broker |

## 故障排查

### 设备无法发送统计

1. 检查 `CONFIG_STATS_API_URL` 是否正确配置
2. 检查网络连接
3. 查看设备日志中的错误信息

### 桥接服务收不到数据

1. 检查服务是否运行
2. 检查端口是否正确
3. 查看服务日志

## 相关文件

- `api-bridge.js` - HTTP API 桥接服务
- `start-api.sh` - 启动脚本
- `conversations.json` - 数据存储文件

