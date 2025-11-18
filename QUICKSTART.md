# 快速开始指南

## 前提条件

1. 安装 Node.js (v14 或更高版本)
   - 访问 https://nodejs.org/ 下载安装

2. 获取设备信息
   - `deviceId`: 设备 MAC 地址（例如：`e4:b0:63:85:96:00`）
   - `clientId`: 设备 UUID（例如：`de89ac1a-9f83-4557-a6f5-f25773bf3dd4`）
   
   可以从设备串口日志中获取：
   ```
   I (229) Board: UUID=de89ac1a-9f83-4557-a6f5-f25773bf3dd4 SKU=longancore-s3
   ```

## 安装和启动

### 步骤 1: 安装依赖

```bash
cd bridge
npm install
```

### 步骤 2: 启动桥接服务

#### 方式 A: 使用启动脚本（推荐）

```bash
./start.sh e4:b0:63:85:96:00 de89ac1a-9f83-4557-a6f5-f25773bf3dd4
```

#### 方式 B: 使用 npm

```bash
npm start e4:b0:63:85:96:00 de89ac1a-9f83-4557-a6f5-f25773bf3dd4
```

#### 方式 C: 使用环境变量

```bash
export DEVICE_ID=e4:b0:63:85:96:00
export CLIENT_ID=de89ac1a-9f83-4557-a6f5-f25773bf3dd4
npm start
```

### 步骤 3: 验证服务运行

打开浏览器访问：
- HTTP API: http://localhost:3000/health
- WebSocket: ws://localhost:8080

应该看到类似输出：
```
✅ HTTP API server listening on http://localhost:3000
✅ WebSocket server listening on ws://localhost:8080
✅ MQTT connected
✅ Subscribed to: xiaozhi/...
```

## 查看对话统计

### 方式 1: 使用前端页面

1. 打开 `docs/conversation_stats.html`
2. 确保 WebSocket 地址是 `ws://localhost:8080`
3. 点击"连接"按钮
4. 触发设备对话，应该能看到统计数据实时更新

### 方式 2: 使用 WebSocket 客户端

```javascript
const ws = new WebSocket('ws://localhost:8080');

ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'conversation_stats') {
        console.log('对话统计:', {
            时长: data.duration + '秒',
            原因: data.reason,
            会话ID: data.session_id
        });
    }
};
```

### 方式 3: 使用 curl 查看统计

```bash
# 查看服务状态
curl http://localhost:3000/health

# 查看统计信息
curl http://localhost:3000/api/stats

# 查看设备列表
curl http://localhost:3000/api/devices
```

## 添加更多设备

如果需要在运行时添加更多设备：

```bash
curl -X POST http://localhost:3000/api/add-device \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "另一个设备的MAC地址",
    "clientId": "另一个设备的UUID"
  }'
```

## 常见问题

### Q: MQTT 连接失败？

A: 检查以下几点：
1. 设备是否已正确配置并连接到网络
2. OTA API 是否返回了正确的 MQTT 配置
3. 网络是否可以访问 MQTT 服务器

### Q: 收不到对话统计消息？

A: 检查以下几点：
1. 设备是否已发送对话统计（查看设备串口日志）
2. MQTT topic 订阅是否正确（查看服务日志）
3. 设备是否使用了正确的 `publish_topic`

### Q: WebSocket 连接失败？

A: 检查以下几点：
1. 桥接服务是否正在运行
2. WebSocket 端口（默认 8080）是否被占用
3. 防火墙是否阻止了连接

## 下一步

- 查看 [README.md](README.md) 了解详细文档
- 查看 [API 文档](README.md#api-文档) 了解所有 API 接口
- 集成到你的前端应用中

