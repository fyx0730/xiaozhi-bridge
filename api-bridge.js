#!/usr/bin/env node

/**
 * 小智AI HTTP API 桥接服务
 * 
 * 功能：
 * 1. 提供 HTTP API 接收设备发送的对话统计
 * 2. 将对话统计消息转发到 WebSocket 客户端
 * 3. 提供 HTTP API 查询历史统计
 * 4. 避免 MQTT 连接问题
 */

const WebSocket = require('ws');
const express = require('express');
const path = require('path');
const fs = require('fs');

class ApiBridge {
    constructor(options = {}) {
        this.app = express();
        this.wss = null;
        this.conversations = []; // 存储对话统计
        this.stats = {
            totalConversations: 0,
            totalDuration: 0,
            websocketClients: 0,
            apiRequests: 0
        };
        
        // 配置选项
        this.options = {
            webSocketPort: options.webSocketPort || 8080,
            httpPort: options.httpPort || 3000,
            dataFile: options.dataFile || path.join(__dirname, 'conversations.json'),
            deviceNamesFile: options.deviceNamesFile || path.join(__dirname, 'device-names.json')
        };
        
        // 设备名称映射 { deviceId: deviceName }
        this.deviceNames = new Map();
        
        // 加载历史数据
        this.loadConversations();
        this.loadDeviceNames();
        
        this.setupExpress();
    }

    /**
     * 配置 Express 应用
     */
    setupExpress() {
        // 启用 CORS 支持
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
            
            // 处理预检请求
            if (req.method === 'OPTIONS') {
                res.sendStatus(200);
                return;
            }
            
            next();
        });
        
        // 解析 JSON 请求体
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, '../docs')));

        // 健康检查
        this.app.get('/health', (req, res) => {
            res.json({ 
                status: 'ok',
                websocket: {
                    clients: this.stats.websocketClients
                },
                stats: {
                    totalConversations: this.stats.totalConversations,
                    totalDuration: this.stats.totalDuration
                }
            });
        });

        // 接收对话统计（设备发送）
        this.app.post('/api/conversation-stats', (req, res) => {
            this.stats.apiRequests++;
            
            const { device_id, session_id, duration, reason, timestamp } = req.body;
            
            // 验证必要字段
            if (typeof duration !== 'number') {
                return res.status(400).json({ 
                    success: false, 
                    error: 'duration is required and must be a number' 
                });
            }

            // 验证和修复时间戳
            // 如果时间戳无效（小于 2020-01-01），使用当前时间
            const minValidTimestamp = 1577836800; // 2020-01-01 00:00:00 UTC
            let validTimestamp = timestamp || Math.floor(Date.now() / 1000);
            if (validTimestamp < minValidTimestamp) {
                console.warn(`⚠️  Invalid timestamp ${validTimestamp}, using current time`);
                validTimestamp = Math.floor(Date.now() / 1000);
            }

            // 设备 ID，如果没有提供则使用 'unknown'
            const deviceId = device_id || 'unknown';

            const conversation = {
                deviceId: deviceId,
                sessionId: session_id || 'unknown',
                duration: duration,
                reason: reason || 'unknown',
                timestamp: validTimestamp,
                receivedAt: Date.now()
            };

            console.log('📊 Received conversation stats:', {
                device_id: conversation.deviceId,
                session_id: conversation.sessionId,
                duration: conversation.duration.toFixed(2) + 's',
                reason: conversation.reason,
                timestamp: new Date(conversation.timestamp * 1000).toLocaleString()
            });

            // 添加到列表
            this.addConversation(conversation);

            // 广播到 WebSocket 客户端
            this.broadcastToWebSocket({
                type: 'conversation_stats',
                device_id: conversation.deviceId,
                session_id: conversation.sessionId,
                duration: conversation.duration,
                reason: conversation.reason,
                timestamp: conversation.timestamp
            });

            res.json({ 
                success: true, 
                message: 'Conversation stats received',
                conversation: conversation
            });
        });

        // 获取所有对话统计（支持按设备筛选）
        this.app.get('/api/conversations', (req, res) => {
            const { limit = 100, offset = 0, device_id } = req.query;
            const start = parseInt(offset);
            const end = start + parseInt(limit);
            
            // 如果指定了设备 ID，只返回该设备的数据
            let filteredConversations = this.conversations;
            if (device_id) {
                filteredConversations = this.conversations.filter(c => c.deviceId === device_id);
            }
            
            // 计算统计信息
            const totalDuration = filteredConversations.reduce((sum, c) => sum + c.duration, 0);
            const totalConversations = filteredConversations.length;
            
            res.json({
                success: true,
                total: filteredConversations.length,
                conversations: filteredConversations.slice(start, end),
                stats: {
                    totalConversations: totalConversations,
                    totalDuration: totalDuration,
                    averageDuration: totalConversations > 0 
                        ? totalDuration / totalConversations 
                        : 0
                },
                device_id: device_id || null
            });
        });

        // 获取设备列表
        this.app.get('/api/devices', (req, res) => {
            const deviceMap = new Map();
            
            // 统计每个设备的数据
            this.conversations.forEach(conv => {
                if (!deviceMap.has(conv.deviceId)) {
                    deviceMap.set(conv.deviceId, {
                        deviceId: conv.deviceId,
                        totalConversations: 0,
                        totalDuration: 0,
                        lastConversation: null
                    });
                }
                const device = deviceMap.get(conv.deviceId);
                device.totalConversations++;
                device.totalDuration += conv.duration;
                if (!device.lastConversation || conv.timestamp > device.lastConversation.timestamp) {
                    device.lastConversation = conv;
                }
            });
            
            const devices = Array.from(deviceMap.values()).map(device => ({
                deviceId: device.deviceId,
                deviceName: this.deviceNames.get(device.deviceId) || null,
                totalConversations: device.totalConversations,
                totalDuration: device.totalDuration,
                averageDuration: device.totalConversations > 0 
                    ? device.totalDuration / device.totalConversations 
                    : 0,
                lastConversation: device.lastConversation ? {
                    sessionId: device.lastConversation.sessionId,
                    timestamp: device.lastConversation.timestamp
                } : null
            }));
            
            res.json({
                success: true,
                devices: devices,
                totalDevices: devices.length
            });
        });

        // 设置设备名称
        this.app.post('/api/devices/:deviceId/name', (req, res) => {
            const { deviceId } = req.params;
            const { name } = req.body;
            
            if (!name || typeof name !== 'string' || name.trim().length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Device name is required and must be a non-empty string'
                });
            }
            
            const trimmedName = name.trim();
            this.deviceNames.set(deviceId, trimmedName);
            this.saveDeviceNames();
            
            console.log(`📝 Set device name: ${deviceId} -> ${trimmedName}`);
            
            res.json({
                success: true,
                deviceId: deviceId,
                deviceName: trimmedName,
                message: 'Device name updated'
            });
        });

        // 获取设备名称
        this.app.get('/api/devices/:deviceId/name', (req, res) => {
            const { deviceId } = req.params;
            const deviceName = this.deviceNames.get(deviceId);
            
            res.json({
                success: true,
                deviceId: deviceId,
                deviceName: deviceName || null
            });
        });

        // 获取所有设备名称
        this.app.get('/api/device-names', (req, res) => {
            const names = {};
            this.deviceNames.forEach((name, deviceId) => {
                names[deviceId] = name;
            });
            
            res.json({
                success: true,
                deviceNames: names
            });
        });

        // 删除设备名称
        this.app.delete('/api/devices/:deviceId/name', (req, res) => {
            const { deviceId } = req.params;
            
            if (this.deviceNames.has(deviceId)) {
                this.deviceNames.delete(deviceId);
                this.saveDeviceNames();
                
                console.log(`🗑️  Removed device name: ${deviceId}`);
                
                res.json({
                    success: true,
                    deviceId: deviceId,
                    message: 'Device name removed'
                });
            } else {
                res.status(404).json({
                    success: false,
                    error: 'Device name not found'
                });
            }
        });

        // 获取特定设备的统计
        this.app.get('/api/devices/:deviceId/stats', (req, res) => {
            const { deviceId } = req.params;
            const deviceConversations = this.conversations.filter(c => c.deviceId === deviceId);
            
            if (deviceConversations.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'Device not found'
                });
            }
            
            const totalDuration = deviceConversations.reduce((sum, c) => sum + c.duration, 0);
            const maxDuration = Math.max(...deviceConversations.map(c => c.duration));
            
            res.json({
                success: true,
                deviceId: deviceId,
                stats: {
                    totalConversations: deviceConversations.length,
                    totalDuration: totalDuration,
                    averageDuration: totalDuration / deviceConversations.length,
                    maxDuration: maxDuration
                },
                conversations: deviceConversations.slice(0, 10) // 最近10条
            });
        });

        // 删除设备（删除该设备的所有对话记录和设备名称）
        this.app.delete('/api/devices/:deviceId', (req, res) => {
            const { deviceId } = req.params;
            
            // 统计要删除的对话数量
            const deviceConversations = this.conversations.filter(c => c.deviceId === deviceId);
            const deletedCount = deviceConversations.length;
            const deletedDuration = deviceConversations.reduce((sum, c) => sum + c.duration, 0);
            
            // 删除该设备的所有对话记录
            this.conversations = this.conversations.filter(c => c.deviceId !== deviceId);
            
            // 更新统计
            this.stats.totalConversations -= deletedCount;
            this.stats.totalDuration -= deletedDuration;
            
            // 删除设备名称（如果存在）
            let deviceNameDeleted = false;
            if (this.deviceNames.has(deviceId)) {
                this.deviceNames.delete(deviceId);
                this.saveDeviceNames();
                deviceNameDeleted = true;
            }
            
            // 保存对话记录
            this.saveConversations();
            
            console.log(`🗑️  Deleted device: ${deviceId} (${deletedCount} conversations, ${deviceNameDeleted ? 'name removed' : 'no name'})`);
            
            res.json({
                success: true,
                deviceId: deviceId,
                deletedConversations: deletedCount,
                deletedDuration: deletedDuration,
                deviceNameDeleted: deviceNameDeleted,
                message: `Device deleted: ${deletedCount} conversations removed`
            });
        });

        // 获取统计摘要（支持按设备筛选）
        this.app.get('/api/stats', (req, res) => {
            const { device_id } = req.query;
            
            // 如果指定了设备 ID，只统计该设备的数据
            let filteredConversations = this.conversations;
            if (device_id) {
                filteredConversations = this.conversations.filter(c => c.deviceId === device_id);
            }
            
            const totalDuration = filteredConversations.reduce((sum, c) => sum + c.duration, 0);
            const totalConversations = filteredConversations.length;
            const maxDuration = filteredConversations.length > 0
                ? Math.max(...filteredConversations.map(c => c.duration))
                : 0;

            // 获取设备列表统计
            const deviceMap = new Map();
            this.conversations.forEach(conv => {
                if (!deviceMap.has(conv.deviceId)) {
                    deviceMap.set(conv.deviceId, { count: 0, duration: 0 });
                }
                const device = deviceMap.get(conv.deviceId);
                device.count++;
                device.duration += conv.duration;
            });

            res.json({
                success: true,
                stats: {
                    totalConversations: totalConversations,
                    totalDuration: totalDuration,
                    averageDuration: totalConversations > 0
                        ? totalDuration / totalConversations
                        : 0,
                    maxDuration: maxDuration,
                    websocketClients: this.stats.websocketClients,
                    apiRequests: this.stats.apiRequests,
                    totalDevices: deviceMap.size
                },
                conversations: filteredConversations.slice(0, 10), // 最近10条
                device_id: device_id || null,
                devices: Array.from(deviceMap.entries()).map(([id, data]) => ({
                    deviceId: id,
                    deviceName: this.deviceNames.get(id) || null,
                    totalConversations: data.count,
                    totalDuration: data.duration
                }))
            });
        });

        // 清空所有数据
        this.app.delete('/api/conversations', (req, res) => {
            this.conversations = [];
            this.stats.totalConversations = 0;
            this.stats.totalDuration = 0;
            this.saveConversations();
            
            res.json({ 
                success: true, 
                message: 'All conversations cleared' 
            });
        });
    }

    /**
     * 添加对话统计
     */
    addConversation(conversation) {
        this.conversations.unshift(conversation); // 添加到开头
        
        // 只保留最近1000条记录
        if (this.conversations.length > 1000) {
            const removed = this.conversations.pop();
            this.stats.totalDuration -= removed.duration;
        } else {
            this.stats.totalConversations++;
            this.stats.totalDuration += conversation.duration;
        }
        
        // 保存到文件
        this.saveConversations();
    }

    /**
     * 保存对话统计到文件
     */
    saveConversations() {
        try {
            const data = {
                conversations: this.conversations,
                stats: {
                    totalConversations: this.stats.totalConversations,
                    totalDuration: this.stats.totalDuration
                },
                savedAt: Date.now()
            };
            fs.writeFileSync(this.options.dataFile, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('❌ Failed to save conversations:', error.message);
        }
    }

    /**
     * 加载历史对话统计
     */
    loadConversations() {
        try {
            if (fs.existsSync(this.options.dataFile)) {
                const data = JSON.parse(fs.readFileSync(this.options.dataFile, 'utf8'));
                this.conversations = data.conversations || [];
                if (data.stats) {
                    this.stats.totalConversations = data.stats.totalConversations || 0;
                    this.stats.totalDuration = data.stats.totalDuration || 0;
                }
                console.log(`📂 Loaded ${this.conversations.length} conversations from file`);
            }
        } catch (error) {
            console.error('❌ Failed to load conversations:', error.message);
        }
    }

    /**
     * 加载设备名称从文件
     */
    loadDeviceNames() {
        try {
            if (fs.existsSync(this.options.deviceNamesFile)) {
                const data = JSON.parse(fs.readFileSync(this.options.deviceNamesFile, 'utf8'));
                this.deviceNames = new Map(Object.entries(data));
                console.log(`✅ Loaded ${this.deviceNames.size} device names from file`);
            } else {
                console.log('📝 No device names file found, starting fresh');
            }
        } catch (error) {
            console.error('❌ Failed to load device names:', error.message);
            this.deviceNames = new Map();
        }
    }

    /**
     * 保存设备名称到文件
     */
    saveDeviceNames() {
        try {
            const data = Object.fromEntries(this.deviceNames);
            fs.writeFileSync(this.options.deviceNamesFile, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('❌ Failed to save device names:', error.message);
        }
    }

    /**
     * 启动 WebSocket 服务器
     */
    startWebSocketServer(port) {
        this.wss = new WebSocket.Server({ port });

        this.wss.on('connection', (ws) => {
            this.stats.websocketClients++;
            console.log(`📱 WebSocket client connected (total: ${this.stats.websocketClients})`);

            // 获取设备列表统计
            const deviceMap = new Map();
            this.conversations.forEach(conv => {
                if (!deviceMap.has(conv.deviceId)) {
                    deviceMap.set(conv.deviceId, { count: 0, duration: 0 });
                }
                const device = deviceMap.get(conv.deviceId);
                device.count++;
                device.duration += conv.duration;
            });

            // 发送欢迎消息和当前统计
            ws.send(JSON.stringify({
                type: 'welcome',
                message: 'Connected to Xiaozhi API Bridge',
                stats: {
                    totalConversations: this.stats.totalConversations,
                    totalDuration: this.stats.totalDuration,
                    averageDuration: this.stats.totalConversations > 0
                        ? this.stats.totalDuration / this.stats.totalConversations
                        : 0,
                    totalDevices: deviceMap.size
                },
                devices: Array.from(deviceMap.entries()).map(([id, data]) => ({
                    deviceId: id,
                    totalConversations: data.count,
                    totalDuration: data.duration
                }))
            }));

            // 发送最近的对话统计
            if (this.conversations.length > 0) {
                this.conversations.slice(0, 10).forEach(conv => {
                    ws.send(JSON.stringify({
                        type: 'conversation_stats',
                        device_id: conv.deviceId,
                        session_id: conv.sessionId,
                        duration: conv.duration,
                        reason: conv.reason,
                        timestamp: conv.timestamp
                    }));
                });
            }

            ws.on('close', () => {
                this.stats.websocketClients--;
                console.log(`📱 WebSocket client disconnected (total: ${this.stats.websocketClients})`);
            });

            ws.on('error', (error) => {
                console.error('❌ WebSocket error:', error.message);
            });
        });

        console.log(`✅ WebSocket server listening on ws://localhost:${port}`);
    }

    /**
     * 广播消息到所有 WebSocket 客户端
     */
    broadcastToWebSocket(data) {
        if (!this.wss) {
            return;
        }
        
        const message = JSON.stringify(data);
        let sentCount = 0;
        
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(message);
                    sentCount++;
                } catch (error) {
                    console.error(`❌ Failed to send to client:`, error);
                }
            }
        });

        if (sentCount > 0) {
            console.log(`📤 Broadcasted to ${sentCount} WebSocket client(s)`);
        }
    }

    /**
     * 启动服务
     */
    async start() {
        // 启动 WebSocket 服务器
        this.startWebSocketServer(this.options.webSocketPort);

        // 启动 HTTP 服务器
        this.app.listen(this.options.httpPort, () => {
            console.log(`✅ HTTP API server listening on http://localhost:${this.options.httpPort}`);
            console.log('📖 API endpoints:');
            console.log('   POST /api/conversation-stats - Receive conversation stats from device');
            console.log('   GET  /api/conversations - Get all conversations (支持 ?device_id=xxx 筛选)');
            console.log('   GET  /api/stats - Get statistics summary (支持 ?device_id=xxx 筛选)');
            console.log('   GET  /api/devices - Get device list');
            console.log('   GET  /api/devices/:deviceId/stats - Get device statistics');
            console.log('   POST /api/devices/:deviceId/name - Set device name');
            console.log('   GET  /api/devices/:deviceId/name - Get device name');
            console.log('   GET  /api/device-names - Get all device names');
            console.log('   DELETE /api/devices/:deviceId/name - Remove device name');
            console.log('   DELETE /api/devices/:deviceId - Delete device (all conversations and name)');
            console.log('   DELETE /api/conversations - Clear all conversations');
            console.log('   GET  /health - Health check');
            console.log('');
            console.log('💡 Device should POST to: http://your-server:3000/api/conversation-stats');
            console.log('💡 Frontend should connect to: ws://localhost:8080');
        });
    }
}

// 主程序
async function main() {
    const bridge = new ApiBridge({
        webSocketPort: parseInt(process.env.WS_PORT) || 8080,
        httpPort: parseInt(process.env.HTTP_PORT) || 3000
    });

    await bridge.start();

    console.log('\n✨ API Bridge service is running!');
    console.log(`   WebSocket: ws://localhost:${bridge.options.webSocketPort}`);
    console.log(`   HTTP API:  http://localhost:${bridge.options.httpPort}`);
    console.log('');
    console.log('📝 To send conversation stats from device, POST to:');
    console.log(`   http://localhost:${bridge.options.httpPort}/api/conversation-stats`);
    console.log('');
}

// 运行主程序
main().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});

