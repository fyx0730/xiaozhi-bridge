# 实现说明

## 项目结构

```
bridge/
├── auto-bridge.js          # 主桥接服务文件
├── package.json            # Node.js 项目配置
├── start.sh               # 快速启动脚本
├── config.example.json    # 配置示例文件
├── README.md              # 详细文档
├── QUICKSTART.md          # 快速开始指南
└── .gitignore            # Git 忽略文件
```

## 核心功能实现

### 1. 自动获取 MQTT 配置

`fetchDeviceConfig()` 方法：
- 模拟设备请求 OTA API
- 自动解析返回的 JSON 中的 MQTT 配置
- 支持自定义 OTA API URL

### 2. MQTT 连接和订阅

`connectMQTT()` 方法：
- 使用 TLS 连接 MQTT 服务器（端口 8883）
- 自动订阅设备消息 topic
- 支持自动重连
- 处理消息解析和转发

### 3. WebSocket 服务器

`startWebSocketServer()` 方法：
- 创建 WebSocket 服务器
- 管理客户端连接
- 广播消息到所有连接的客户端
- 支持心跳检测

### 4. HTTP API

提供 RESTful API：
- `GET /health` - 健康检查
- `POST /api/add-device` - 添加设备
- `GET /api/stats` - 获取统计信息
- `GET /api/devices` - 获取设备列表

## 工作流程

```
1. 启动桥接服务
   ↓
2. 从 OTA API 获取 MQTT 配置（自动或通过 API）
   ↓
3. 连接 MQTT 服务器
   ↓
4. 订阅设备消息 topic
   ↓
5. 接收对话统计消息
   ↓
6. 转发到所有 WebSocket 客户端
   ↓
7. 前端实时显示统计数据
```

## 消息流转

```
设备 (ESP32)
  ↓ 发送对话统计
MQTT 服务器 (mqtt.xiaozhi.me)
  ↓ MQTT 消息
桥接服务 (auto-bridge.js)
  ↓ WebSocket 消息
前端页面 (conversation_stats.html)
  ↓ 显示统计
用户界面
```

## 配置说明

### MQTT Topic 订阅策略

代码会根据以下优先级确定订阅 topic：

1. 如果 `publish_topic` 存在：
   - 将 `/publish` 替换为 `/#` 进行订阅
   - 例如：`xiaozhi/xxx/publish` → `xiaozhi/xxx/#`

2. 如果 `client_id` 存在：
   - 订阅 `xiaozhi/{client_id}/#`

3. 如果 `deviceId` 存在：
   - 订阅 `xiaozhi/{deviceId}/#`（MAC 地址中的冒号会被替换为横线）

4. 默认：
   - 订阅 `xiaozhi/+/publish`（通配符订阅所有设备）

### 环境变量配置

所有配置都可以通过环境变量覆盖：

```bash
export WS_PORT=8080
export HTTP_PORT=3000
export OTA_API_URL=https://api.tenclass.net/xiaozhi/ota/
export BOARD_TYPE=longancore-s3
export BOARD_NAME=longancore-s3
export DEVICE_ID=e4:b0:63:85:96:00
export CLIENT_ID=de89ac1a-9f83-4557-a6f5-f25773bf3dd4
```

## 错误处理

### MQTT 连接错误

- 自动重连机制（每 5 秒重试）
- 连接超时设置（10 秒）
- 错误日志记录

### WebSocket 错误

- 客户端断开自动清理
- 错误消息记录
- 连接状态监控

### OTA API 错误

- 请求超时处理（10 秒）
- JSON 解析错误处理
- 详细的错误消息

## 性能优化

1. **消息缓存**：可以添加消息队列缓存未发送的消息
2. **连接池**：多设备时可以复用 MQTT 连接
3. **消息过滤**：只转发对话统计消息，忽略其他消息类型

## 安全考虑

1. **密码保护**：MQTT 密码不会打印到日志
2. **HTTPS/TLS**：OTA API 和 MQTT 都使用加密连接
3. **输入验证**：HTTP API 输入参数验证
4. **错误信息**：不暴露敏感信息到错误消息

## 扩展功能建议

1. **数据库存储**：将对话统计保存到数据库
2. **消息队列**：使用 Redis/RabbitMQ 进行消息队列
3. **认证机制**：为 WebSocket 连接添加认证
4. **监控告警**：添加 Prometheus 监控指标
5. **日志系统**：集成 Winston 或类似日志库

## 测试

### 手动测试

1. 启动服务：`npm start <deviceId> <clientId>`
2. 检查健康状态：`curl http://localhost:3000/health`
3. 触发设备对话
4. 查看 WebSocket 消息

### 自动化测试

可以添加单元测试和集成测试：
- MQTT 连接测试
- WebSocket 消息转发测试
- HTTP API 测试

## 部署建议

### 开发环境

```bash
npm run dev  # 使用 nodemon 自动重启
```

### 生产环境

1. 使用 PM2 进程管理：
```bash
npm install -g pm2
pm2 start auto-bridge.js --name xiaozhi-bridge
pm2 save
pm2 startup
```

2. 使用 Docker：
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000 8080
CMD ["node", "auto-bridge.js"]
```

3. 使用 systemd 服务：
创建 `/etc/systemd/system/xiaozhi-bridge.service`

## 故障排查

查看日志输出，常见问题：

1. **MQTT 连接失败**：检查网络和配置
2. **订阅失败**：检查 topic 格式
3. **收不到消息**：检查设备是否发送消息
4. **WebSocket 连接失败**：检查端口和防火墙

## 相关文件

- ESP32 代码：`main/protocols/protocol.cc` - `SendConversationStats()`
- 前端页面：`docs/conversation_stats.html`
- 使用文档：`docs/conversation_stats_usage.md`

