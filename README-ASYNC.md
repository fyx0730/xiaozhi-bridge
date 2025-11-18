# 使用 async-mqtt 版本的桥接服务

## 概述

这是使用 `async-mqtt` 库的桥接服务版本。`async-mqtt` 提供了更好的 Promise 支持和错误处理，可能解决连接稳定性问题。

## 主要区别

### 原版本 (mqtt)
- 使用 `mqtt` 库（回调风格）
- 连接和订阅使用回调函数
- 错误处理相对复杂

### async-mqtt 版本
- 使用 `async-mqtt` 库（Promise 风格）
- 连接和订阅使用 async/await
- 更好的错误处理和连接管理
- 自动重连机制更稳定

## 使用方法

### 快速启动

```bash
cd bridge
./start-async.sh e4:b0:63:85:96:00 de89ac1a-9f83-4557-a6f5-f25773bf3dd4
```

### 或者使用 npm

```bash
cd bridge
npm run start:async e4:b0:63:85:96:00 de89ac1a-9f83-4557-a6f5-f25773bf3dd4
```

### 开发模式（自动重启）

```bash
npm run dev:async e4:b0:63:85:96:00 de89ac1a-9f83-4557-a6f5-f25773bf3dd4
```

## 功能特性

- ✅ 自动从 OTA API 获取 MQTT 配置
- ✅ 使用 Promise 风格的连接和订阅
- ✅ 更好的错误处理和日志
- ✅ 自动重连机制
- ✅ WebSocket 消息转发
- ✅ HTTP API 管理设备

## 如果仍然遇到连接问题

1. **检查网络连接**：确保可以访问 MQTT 服务器
2. **检查认证信息**：确认 username 和 password 正确
3. **检查服务器 ACL**：确认有权限订阅相关 topics
4. **查看详细日志**：检查错误信息

## 切换回原版本

如果想切换回原版本（使用 mqtt 库）：

```bash
./start.sh e4:b0:63:85:96:00 de89ac1a-9f83-4557-a6f5-f25773bf3dd4
```

## 技术细节

### async-mqtt 的优势

1. **Promise 支持**：使用 async/await，代码更清晰
2. **更好的错误处理**：Promise 的错误处理更直观
3. **连接管理**：自动处理连接状态
4. **重连机制**：更稳定的自动重连

### 代码示例

```javascript
// 连接
this.mqttClient = await mqtt.connectAsync(mqttUrl, options);

// 订阅
await this.mqttClient.subscribe(topic, { qos: 1 });

// 断开
await this.mqttClient.end();
```

## 故障排查

### 连接立即断开

如果连接成功但立即断开，可能的原因：
1. 服务器 ACL 限制
2. 认证问题
3. client_id 冲突

### 订阅失败

如果订阅失败，检查：
1. 是否有权限订阅该 topic
2. topic 名称是否正确
3. 连接是否稳定

## 相关文件

- `auto-bridge-async.js` - async-mqtt 版本的桥接服务
- `auto-bridge.js` - 原版本（mqtt 库）
- `start-async.sh` - async 版本的启动脚本
- `start.sh` - 原版本的启动脚本

