#!/usr/bin/env node

/**
 * 小智AI MQTT 到 WebSocket 自动桥接服务 (使用 async-mqtt)
 * 
 * 功能：
 * 1. 自动从 OTA API 获取 MQTT 配置
 * 2. 连接 MQTT 服务器并订阅设备消息
 * 3. 将对话统计消息转发到 WebSocket 客户端
 * 4. 提供 HTTP API 管理设备
 */

const mqtt = require('async-mqtt');
const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const express = require('express');
const path = require('path');

class AutoBridge {
    constructor(options = {}) {
        this.app = express();
        this.mqttClient = null;
        this.wss = null;
        this.mqttConfig = null;
        this.deviceConfigs = new Map();
        this.publishTopic = null;
        this.stats = {
            mqttMessages: 0,
            websocketClients: 0,
            conversationStats: 0
        };
        
        // 配置选项
        this.options = {
            webSocketPort: options.webSocketPort || 8080,
            httpPort: options.httpPort || 3000,
            otaApiUrl: options.otaApiUrl || 'https://api.tenclass.net/xiaozhi/ota/',
            boardType: options.boardType || process.env.BOARD_TYPE || 'longancore-s3',
            boardName: options.boardName || process.env.BOARD_NAME || 'longancore-s3'
        };
        
        this.setupExpress();
    }

    /**
     * 配置 Express 应用
     */
    setupExpress() {
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, '../docs')));

        // 健康检查
        this.app.get('/health', (req, res) => {
            res.json({ 
                status: 'ok',
                mqtt: {
                    connected: this.mqttClient?.connected || false
                },
                websocket: {
                    clients: this.stats.websocketClients
                }
            });
        });

        // 添加设备
        this.app.post('/api/add-device', async (req, res) => {
            const { deviceId, clientId } = req.body;
            if (!deviceId || !clientId) {
                return res.status(400).json({ success: false, error: 'deviceId and clientId are required' });
            }
            
            const result = await this.addDevice(deviceId, clientId);
            res.json(result);
        });

        // 获取统计信息
        this.app.get('/api/stats', (req, res) => {
            res.json({
                mqtt: {
                    connected: this.mqttClient?.connected || false,
                    messages: this.stats.mqttMessages
                },
                websocket: {
                    clients: this.stats.websocketClients
                },
                conversationStats: this.stats.conversationStats,
                stats: this.stats,
                devices: Array.from(this.deviceConfigs.keys())
            });
        });

        // 获取设备列表
        this.app.get('/api/devices', (req, res) => {
            const devices = Array.from(this.deviceConfigs.entries()).map(([deviceId, config]) => ({
                deviceId,
                endpoint: config.endpoint,
                client_id: config.client_id,
                publish_topic: config.publish_topic
            }));
            res.json({ devices });
        });
    }

    /**
     * 从 OTA API 获取设备配置
     */
    async fetchDeviceConfig(deviceId, clientId) {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify({
                type: this.options.boardType,
                name: this.options.boardName,
                mac: deviceId
            });

            const url = new URL(this.options.otaApiUrl);
            
            const options = {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                    'Device-Id': deviceId,
                    'Client-Id': clientId,
                    'Accept-Language': 'zh-CN',
                    'User-Agent': 'xiaozhi-bridge/1.0.0'
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        console.log('📥 OTA API response:', JSON.stringify(json, null, 2));
                        if (json.mqtt) {
                            resolve({
                                ...json.mqtt,
                                deviceId,
                                clientId
                            });
                        } else {
                            console.error('❌ OTA response structure:', JSON.stringify(json, null, 2));
                            reject(new Error('MQTT config not found in OTA response'));
                        }
                    } catch (e) {
                        console.error('❌ Failed to parse OTA response:', data);
                        reject(new Error(`Failed to parse OTA response: ${e.message}`));
                    }
                });
            });

            req.on('error', (error) => {
                reject(new Error(`OTA API request failed: ${error.message}`));
            });

            req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error('OTA API request timeout'));
            });

            req.write(postData);
            req.end();
        });
    }

    /**
     * 连接 MQTT 服务器 (使用 async-mqtt)
     */
    async connectMQTT(config) {
        try {
            // 如果已经连接，先断开
            if (this.mqttClient) {
                try {
                    await this.mqttClient.end();
                } catch (e) {
                    // 忽略断开错误
                }
            }

            // 保存 publish_topic
            this.publishTopic = config.publish_topic;
            console.log(`💾 Saved publish_topic: ${this.publishTopic}`);

            const mqttUrl = `mqtts://${config.endpoint}:8883`;
            console.log(`🔌 Connecting to MQTT: ${config.endpoint}`);

            // 使用完全独立的 client_id
            const deviceClientId = config.client_id || `bridge-${Date.now()}`;
            const bridgeClientId = `xiaozhi-bridge-${Date.now()}-${Math.random().toString(36).substring(7)}`;
            console.log(`🔑 Device client_id: ${deviceClientId}`);
            console.log(`🔑 Bridge client_id: ${bridgeClientId}`);
            console.log(`🔑 Using username: ${config.username}`);

            // 使用 async-mqtt 连接
            this.mqttClient = await mqtt.connectAsync(mqttUrl, {
                clientId: bridgeClientId,
                username: config.username,
                password: config.password,
                clean: true,
                reconnectPeriod: 10000,
                connectTimeout: 15000,
                keepalive: 30,
                protocolVersion: 4
            });

            console.log('✅ MQTT connected');

            // 设置消息处理
            this.mqttClient.on('message', (topic, message) => {
                this.stats.mqttMessages++;
                
                const isDevicePublish = topic === this.publishTopic;
                
                console.log('\n📥 MQTT message received:');
                console.log('   Topic:', topic);
                console.log('   Expected publish topic:', this.publishTopic);
                console.log('   Topic match:', topic === this.publishTopic ? '✅ MATCH' : '❌ NO MATCH');
                console.log('   Is device publish:', isDevicePublish ? '✅ YES' : '❌ NO');
                console.log('   Raw message length:', message.toString().length, 'bytes');
                
                if (isDevicePublish) {
                    console.log('   ⭐⭐ DEVICE PUBLISHED MESSAGE ⭐⭐');
                    console.log('   Full message:', message.toString());
                } else {
                    console.log('   Raw message:', message.toString().substring(0, 500) + (message.toString().length > 500 ? '...' : ''));
                }
                
                try {
                    const data = JSON.parse(message.toString());
                    console.log('   Message type:', data.type);
                    
                    if (data.type === 'conversation_stats') {
                        this.stats.conversationStats++;
                        console.log('✅✅✅ CONVERSATION STATS DETECTED! ✅✅✅');
                        console.log('   Session ID:', data.session_id);
                        console.log('   Duration:', data.duration?.toFixed(2) + 's');
                        console.log('   Reason:', data.reason);
                        console.log('   Timestamp:', new Date(data.timestamp * 1000).toLocaleString());
                        
                        this.broadcastToWebSocket(data);
                    } else if (isDevicePublish && data.duration !== undefined && data.session_id) {
                        console.log('💡 Message looks like conversation stats but type is:', data.type);
                        console.log('   Attempting to forward anyway...');
                        const statsMessage = {
                            type: 'conversation_stats',
                            session_id: data.session_id,
                            duration: data.duration,
                            reason: data.reason || 'unknown',
                            timestamp: data.timestamp || Math.floor(Date.now() / 1000)
                        };
                        this.broadcastToWebSocket(statsMessage);
                    }
                } catch (e) {
                    console.error('❌ Error parsing MQTT message:', e.message);
                    console.error('   Raw message:', message.toString());
                }
            });

            // 设置错误处理
            this.mqttClient.on('error', (error) => {
                console.error('❌ MQTT error:', error.message);
            });

            this.mqttClient.on('close', () => {
                console.log('⚠️  MQTT connection closed');
            });

            this.mqttClient.on('reconnect', () => {
                console.log('🔄 MQTT reconnecting...');
            });

            this.mqttClient.on('offline', () => {
                console.log('⚠️  MQTT client offline');
            });

            // 订阅 topics
            const subscribeTopics = [];
            
            if (config.publish_topic) {
                subscribeTopics.push(config.publish_topic);
                console.log(`📌 Device publishes to: ${config.publish_topic}`);
            }
            
            if (config.deviceId) {
                const deviceTopic = `devices/p2p/${config.deviceId.replace(/:/g, '_')}`;
                subscribeTopics.push(deviceTopic);
                console.log(`📌 Server sends to device: ${deviceTopic}`);
            }
            
            // 订阅所有 topics
            for (const topic of subscribeTopics) {
                try {
                    await this.mqttClient.subscribe(topic, { qos: 1 });
                    console.log(`✅ Subscribed to: ${topic}`);
                } catch (error) {
                    console.error(`❌ Failed to subscribe to ${topic}:`, error.message);
                }
            }

            // 也订阅通配符 topic
            try {
                await this.mqttClient.subscribe('#', { qos: 1 });
                console.log(`✅ Subscribed to: # (all topics - for debugging)`);
            } catch (error) {
                console.warn(`⚠️  Failed to subscribe to #:`, error.message);
            }

            console.log('\n📡 Listening for messages on all subscribed topics...');
            console.log(`💾 Saved publish_topic: ${this.publishTopic}`);
            console.log('💡 Trigger a conversation on the device to see conversation stats\n');

        } catch (error) {
            console.error('❌ Failed to connect MQTT:', error.message);
            throw error;
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

            // 发送欢迎消息
            ws.send(JSON.stringify({
                type: 'welcome',
                message: 'Connected to Xiaozhi Bridge',
                stats: this.stats
            }));

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
            console.warn('⚠️  WebSocket server not initialized');
            return;
        }
        
        const message = JSON.stringify(data);
        console.log('📤 Broadcasting message:', message);
        let sentCount = 0;
        
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(message);
                    sentCount++;
                    console.log(`   ✅ Sent to client ${sentCount}`);
                } catch (error) {
                    console.error(`   ❌ Failed to send to client:`, error);
                }
            } else {
                console.log(`   ⚠️  Client not ready, state: ${client.readyState}`);
            }
        });

        if (sentCount > 0) {
            console.log(`✅ Broadcasted to ${sentCount} WebSocket client(s)`);
        } else {
            console.warn('⚠️  No clients connected to receive message');
        }
    }

    /**
     * 添加设备
     */
    async addDevice(deviceId, clientId) {
        try {
            console.log(`🔍 Fetching config for device: ${deviceId}`);
            const config = await this.fetchDeviceConfig(deviceId, clientId);
            
            this.deviceConfigs.set(deviceId, config);
            console.log('✅ Device config fetched:', {
                endpoint: config.endpoint,
                client_id: config.client_id,
                username: config.username,
                publish_topic: config.publish_topic
            });

            // 连接 MQTT（如果还没有连接）
            if (!this.mqttClient || !this.mqttClient.connected) {
                await this.connectMQTT(config);
            }

            return {
                success: true,
                deviceId,
                config: {
                    endpoint: config.endpoint,
                    client_id: config.client_id,
                    username: config.username,
                    publish_topic: config.publish_topic
                }
            };
        } catch (error) {
            console.error('❌ Failed to add device:', error.message);
            return {
                success: false,
                error: error.message
            };
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
            console.log('   GET  /health - Health check');
            console.log('   POST /api/add-device - Add device');
            console.log('   GET  /api/stats - Get statistics');
            console.log('   GET  /api/devices - List devices');
        });
    }
}

// 主程序
async function main() {
    const deviceId = process.argv[2];
    const clientId = process.argv[3];

    const bridge = new AutoBridge({
        webSocketPort: parseInt(process.env.WS_PORT) || 8080,
        httpPort: parseInt(process.env.HTTP_PORT) || 3000,
        otaApiUrl: process.env.OTA_API_URL || 'https://api.tenclass.net/xiaozhi/ota/'
    });

    await bridge.start();

    if (deviceId && clientId) {
        console.log('\n🚀 Auto-adding device...');
        console.log(`   设备ID: ${deviceId}`);
        console.log(`   客户端ID: ${clientId}\n`);
        
        const result = await bridge.addDevice(deviceId, clientId);
        if (result.success) {
            console.log('✅ Device added successfully!');
        } else {
            console.error('❌ Failed to add device:', result.error);
        }
    }

    console.log('\n✨ Bridge service is running!');
    console.log(`   WebSocket: ws://localhost:${bridge.options.webSocketPort}`);
    console.log(`   HTTP API:  http://localhost:${bridge.options.httpPort}`);
}

// 运行主程序
main().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});

