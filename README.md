# 小智AI MQTT 到 WebSocket 桥接服务

自动化的 MQTT 到 WebSocket 桥接服务，用于将小智AI设备的对话统计消息转发到 WebSocket 客户端。

## 功能特性

- ✅ **自动获取配置**：从 OTA API 自动获取设备的 MQTT 配置
- ✅ **MQTT 订阅**：自动连接 MQTT 服务器并订阅设备消息
- ✅ **WebSocket 转发**：将对话统计消息实时转发到 WebSocket 客户端
- ✅ **HTTP API**：提供 RESTful API 管理设备
- ✅ **多设备支持**：支持同时监控多个设备
- ✅ **自动重连**：MQTT 连接断开时自动重连

## 快速开始

### 1. 安装依赖

```bash
cd bridge
npm install
```

### 2. 运行服务

#### 方式 1：命令行参数

```bash
npm start <deviceId> <clientId>
```

示例：
```bash
npm start e4:b0:63:85:96:00 de89ac1a-9f83-4557-a6f5-f25773bf3dd4
```

#### 方式 2：环境变量

```bash
DEVICE_ID=e4:b0:63:85:96:00 CLIENT_ID=de89ac1a-9f83-4557-a6f5-f25773bf3dd4 npm start
```

#### 方式 3：先启动服务，后添加设备

```bash
npm start
```

然后通过 HTTP API 添加设备：
```bash
curl -X POST http://localhost:3000/api/add-device \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"e4:b0:63:85:96:00","clientId":"de89ac1a-9f83-4557-a6f5-f25773bf3dd4"}'
```

## 配置选项

### 环境变量

- `WS_PORT` - WebSocket 服务器端口（默认：8080）
- `HTTP_PORT` - HTTP API 端口（默认：3000）
- `OTA_API_URL` - OTA API 地址（默认：https://api.tenclass.net/xiaozhi/ota/）
- `BOARD_TYPE` - 设备板型（默认：longancore-s3）
- `BOARD_NAME` - 设备名称（默认：longancore-s3）
- `DEVICE_ID` - 设备 MAC 地址
- `CLIENT_ID` - 设备客户端 ID

## API 文档

### 健康检查

```bash
GET /health
```

响应：
```json
{
  "status": "ok",
  "mqtt": {
    "connected": true
  },
  "websocket": {
    "clients": 2
  },
  "stats": {
    "mqttMessages": 10,
    "websocketClients": 2,
    "conversationStats": 5
  }
}
```

### 添加设备

```bash
POST /api/add-device
Content-Type: application/json

{
  "deviceId": "e4:b0:63:85:96:00",
  "clientId": "de89ac1a-9f83-4557-a6f5-f25773bf3dd4"
}
```

响应：
```json
{
  "success": true,
  "deviceId": "e4:b0:63:85:96:00",
  "config": {
    "endpoint": "mqtt.xiaozhi.me",
    "client_id": "...",
    "username": "...",
    "publish_topic": "..."
  }
}
```

### 获取统计信息

```bash
GET /api/stats
```

### 获取设备列表

```bash
GET /api/devices
```

## WebSocket 消息格式

### 客户端连接

连接到 `ws://localhost:8080`，会收到欢迎消息：

```json
{
  "type": "welcome",
  "message": "Connected to Xiaozhi Bridge",
  "stats": {
    "mqttMessages": 0,
    "websocketClients": 1,
    "conversationStats": 0
  }
}
```

### 对话统计消息

当设备发送对话统计时，会收到：

```json
{
  "session_id": "xxx-xxx-xxx",
  "type": "conversation_stats",
  "duration": 12.34,
  "reason": "tts_stop",
  "timestamp": 1234567890
}
```

### 心跳

客户端可以发送 ping 消息：
```json
{
  "type": "ping"
}
```

服务器会回复：
```json
{
  "type": "pong"
}
```

## 前端集成示例

```javascript
const ws = new WebSocket('ws://localhost:8080');

ws.onopen = () => {
    console.log('Connected to bridge');
};

ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    
    if (message.type === 'conversation_stats') {
        console.log('Conversation stats:', {
            sessionId: message.session_id,
            duration: message.duration,
            reason: message.reason,
            timestamp: new Date(message.timestamp * 1000)
        });
        
        // 更新 UI
        updateStatsDisplay(message);
    }
};

ws.onerror = (error) => {
    console.error('WebSocket error:', error);
};

ws.onclose = () => {
    console.log('Disconnected from bridge');
    // 自动重连
    setTimeout(() => {
        ws = new WebSocket('ws://localhost:8080');
    }, 5000);
};
```

## 获取设备信息

### 从串口日志获取

设备启动时会在串口输出：
```
I (229) Board: UUID=de89ac1a-9f83-4557-a6f5-f25773bf3dd4 SKU=longancore-s3
I (4409) MQTT: Connecting to endpoint mqtt.xiaozhi.me
```

- `UUID` 就是 `clientId`
- `Device-Id` 是设备的 MAC 地址（例如：`e4:b0:63:85:96:00`）

### 从设备配置获取

如果设备已连接，可以通过串口查看或使用 ESP-IDF 工具读取 NVS。

## 故障排查

### MQTT 连接失败

1. 检查设备是否已正确配置 MQTT
2. 确认 OTA API 返回了正确的 MQTT 配置
3. 检查网络连接和防火墙设置

### 收不到消息

1. 确认设备已发送对话统计消息
2. 检查 MQTT topic 订阅是否正确
3. 查看服务日志确认消息是否被接收

### WebSocket 连接问题

1. 确认 WebSocket 服务器端口未被占用
2. 检查防火墙设置
3. 查看浏览器控制台的错误信息

## 开发模式

使用 `nodemon` 进行开发，代码修改后自动重启：

```bash
npm run dev
```

## 许可证

MIT

