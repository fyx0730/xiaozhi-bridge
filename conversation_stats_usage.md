# 对话时长统计功能使用说明

## 功能概述

该功能可以实时记录和显示小智AI设备的对话时长统计信息，包括：
- 总对话次数
- 总对话时长
- 平均对话时长
- 最长对话时长
- 详细的对话记录列表

## 后端实现（ESP32）

### 已实现的功能

1. **协议层** (`main/protocols/protocol.h` 和 `protocol.cc`)
   - 添加了 `SendConversationStats()` 方法
   - 在对话结束时自动发送统计信息到服务器

2. **应用层** (`main/application.cc`)
   - 在 `StopConversationTimer()` 方法中调用统计发送
   - 对话结束时自动触发统计发送

### 发送的消息格式

ESP32 设备会在每次对话结束时发送以下 JSON 消息：

```json
{
  "session_id": "xxx-xxx-xxx",
  "type": "conversation_stats",
  "duration": 12.34,
  "reason": "tts_stop",
  "timestamp": 1234567890
}
```

字段说明：
- `session_id`: 会话ID，用于标识本次对话
- `type`: 消息类型，固定为 `"conversation_stats"`
- `duration`: 对话时长（秒），浮点数
- `reason`: 对话结束原因（如 "tts_stop", "manual_stop", "channel_closed" 等）
- `timestamp`: Unix 时间戳（秒）

## 前端显示

### 使用方式

1. **打开前端页面**
   - 文件位置：`docs/conversation_stats.html`
   - 在浏览器中打开该文件

2. **配置 WebSocket 地址**
   - 在页面顶部的输入框中输入你的 WebSocket 代理地址
   - 例如：`wss://your-proxy-server.com/ws`
   - 点击"连接"按钮

3. **查看统计数据**
   - 页面会自动显示实时统计数据
   - 对话记录会实时更新

### 功能特性

- ✅ 实时接收对话统计消息
- ✅ 自动计算总时长、平均时长、最长时长
- ✅ 显示最近100条对话记录
- ✅ 数据自动保存到浏览器本地存储（localStorage）
- ✅ 页面刷新后自动恢复历史数据
- ✅ 响应式设计，支持移动端和桌面端

### 前端页面功能

1. **统计卡片**
   - 总对话次数：累计的对话次数
   - 总对话时长：所有对话的总时长
   - 平均对话时长：总时长除以对话次数
   - 最长对话：单次对话的最长时长

2. **对话记录列表**
   - 显示最近100条对话记录
   - 每条记录包含：会话ID、时长、结束原因、时间戳

## 服务器端处理

### WebSocket 服务器示例（Node.js）

```javascript
const WebSocket = require('ws');

wss.on('connection', (ws, req) => {
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            
            if (message.type === 'conversation_stats') {
                console.log('收到对话统计:', message);
                
                // 保存到数据库
                saveConversationStats({
                    sessionId: message.session_id,
                    duration: message.duration,
                    reason: message.reason,
                    timestamp: message.timestamp,
                    deviceId: req.headers['device-id'],
                    clientId: req.headers['client-id']
                });
                
                // 可选：广播给所有连接的客户端
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(message));
                    }
                });
            }
        } catch (error) {
            console.error('处理消息错误:', error);
        }
    });
});

// 保存到数据库的函数
async function saveConversationStats(stats) {
    // 使用你喜欢的数据库（MongoDB, PostgreSQL, MySQL等）
    // 例如使用 MongoDB:
    // await db.collection('conversations').insertOne(stats);
}
```

### 数据库表结构建议

```sql
CREATE TABLE conversation_stats (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    session_id VARCHAR(255) NOT NULL,
    device_id VARCHAR(255),
    client_id VARCHAR(255),
    duration DECIMAL(10, 2) NOT NULL,
    reason VARCHAR(50),
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_session_id (session_id),
    INDEX idx_timestamp (timestamp),
    INDEX idx_device_id (device_id)
);
```

## 部署说明

### 1. WebSocket 代理服务器

由于浏览器无法直接设置 WebSocket 请求头，你需要一个代理服务器来：
- 接收浏览器的 WebSocket 连接
- 添加必要的请求头（Authorization, Device-Id, Client-Id 等）
- 转发到实际的 WebSocket 服务器

### 2. 代理服务器示例（Node.js）

```javascript
const WebSocket = require('ws');
const http = require('http');

// 代理服务器
const proxyServer = http.createServer();
const proxyWs = new WebSocket.Server({ server: proxyServer });

proxyWs.on('connection', (clientWs, req) => {
    // 从查询参数或 Cookie 获取 token
    const token = req.url.split('token=')[1]?.split('&')[0];
    
    // 连接到实际服务器
    const serverWs = new WebSocket('wss://actual-server.com/ws', {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Protocol-Version': '1',
            'Device-Id': req.headers['device-id'] || '',
            'Client-Id': req.headers['client-id'] || ''
        }
    });
    
    // 双向转发消息
    clientWs.on('message', (data) => {
        if (serverWs.readyState === WebSocket.OPEN) {
            serverWs.send(data);
        }
    });
    
    serverWs.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data);
        }
    });
    
    clientWs.on('close', () => serverWs.close());
    serverWs.on('close', () => clientWs.close());
});

proxyServer.listen(8080, () => {
    console.log('Proxy server listening on port 8080');
});
```

## 测试

1. **编译并烧录固件**
   ```bash
   idf.py build flash monitor
   ```

2. **启动对话**
   - 触发设备开始对话
   - 完成对话后，检查串口日志，应该能看到对话时长打印

3. **查看前端**
   - 打开 `conversation_stats.html`
   - 配置 WebSocket 地址并连接
   - 触发一次对话，应该能看到统计数据更新

## 注意事项

1. **时间同步**：确保设备时间已同步，`time(nullptr)` 才能返回正确的时间戳
2. **网络连接**：只有在 WebSocket 连接打开时才会发送统计数据
3. **数据持久化**：前端数据保存在 localStorage，清除浏览器数据会丢失
4. **服务器存储**：建议在服务器端保存统计数据到数据库，以便长期分析和查询

## 扩展功能建议

1. **历史数据查询**：通过 REST API 查询历史对话记录
2. **数据可视化**：使用图表库（如 Chart.js）显示对话时长趋势
3. **导出功能**：支持导出统计数据为 CSV 或 Excel
4. **筛选和搜索**：按时间范围、设备ID等条件筛选对话记录
5. **统计分析**：按日期、时间段等维度进行统计分析

