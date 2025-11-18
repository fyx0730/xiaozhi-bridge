#!/usr/bin/env node

/**
 * 小智AI MQTT 到 WebSocket 自动桥接服务
 * 
 * 功能：
 * 1. 自动从 OTA API 获取 MQTT 配置
 * 2. 连接 MQTT 服务器并订阅设备消息
 * 3. 将对话统计消息转发到 WebSocket 客户端
 * 4. 提供 HTTP API 管理设备
 */

const mqtt = require('mqtt');
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
        this.publishTopic = null; // 保存设备发布 topic
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
            boardType: options.boardType || 'longancore-s3',
            boardName: options.boardName || 'longancore-s3'
        };
    }

    /**
     * 从 OTA API 获取设备配置（包括 MQTT 配置）
     */
    async fetchDeviceConfig(deviceId, clientId) {
        const postData = JSON.stringify({
            type: this.options.boardType,
            name: this.options.boardName,
            mac: deviceId
        });

        return new Promise((resolve, reject) => {
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
                        if (json.mqtt) {
                            resolve({
                                ...json.mqtt,
                                deviceId,
                                clientId
                            });
                        } else {
                            reject(new Error('No MQTT config in OTA response'));
                        }
                    } catch (e) {
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
     * 连接 MQTT 服务器
     */
    async connectMQTT(config) {
        return new Promise((resolve, reject) => {
            if (this.mqttClient && this.mqttClient.connected) {
                console.log('✅ MQTT already connected');
                resolve();
                return;
            }

            // 保存 publish_topic 到实例变量
            this.publishTopic = config.publish_topic;
            console.log(`💾 Saved publish_topic: ${this.publishTopic}`);

            const mqttUrl = `mqtts://${config.endpoint}:8883`;
            console.log(`🔌 Connecting to MQTT: ${config.endpoint}`);

            // 使用完全独立的 client_id，避免与设备冲突
            // 服务器可能根据 client_id 和 username 的组合来验证权限
            const deviceClientId = config.client_id || `bridge-${Date.now()}`;
            // 使用简单的独立 client_id，不基于设备的 client_id
            const bridgeClientId = `xiaozhi-bridge-${Date.now()}-${Math.random().toString(36).substring(7)}`;
            console.log(`🔑 Device client_id: ${deviceClientId}`);
            console.log(`🔑 Bridge client_id: ${bridgeClientId}`);
            console.log(`🔑 Using username: ${config.username}`);
            
            this.mqttClient = mqtt.connect(mqttUrl, {
                clientId: bridgeClientId,
                username: config.username,
                password: config.password,
                clean: true,
                reconnectPeriod: 10000, // 增加重连间隔，避免频繁重连
                connectTimeout: 15000, // 增加连接超时
                keepalive: 30, // 减少 keepalive 间隔
                // 添加连接选项以提高稳定性
                protocolVersion: 4, // MQTT 3.1.1
                resubscribe: false, // 禁用自动重新订阅，手动控制
                // 添加 will 消息，让服务器知道这是正常断开
                will: {
                    topic: `bridge/${bridgeClientId}/status`,
                    payload: 'offline',
                    qos: 0,
                    retain: false
                }
            });

            // 保存订阅配置，以便重连时重新订阅
            const subscribeConfig = {
                publishTopic: config.publish_topic,
                deviceId: config.deviceId,
                isFirstConnect: true
            };

            // 订阅函数（可以在连接和重连时调用）
            const doSubscribe = () => {
                const subscribeTopics = [];
                
                if (subscribeConfig.publishTopic) {
                    subscribeTopics.push(subscribeConfig.publishTopic);
                    console.log(`📌 Device publishes to: ${subscribeConfig.publishTopic}`);
                }
                
                if (subscribeConfig.deviceId) {
                    const deviceTopic = `devices/p2p/${subscribeConfig.deviceId.replace(/:/g, '_')}`;
                    subscribeTopics.push(deviceTopic);
                    console.log(`📌 Server sends to device: ${deviceTopic}`);
                }
                
                if (subscribeTopics.length === 0) {
                    if (config.client_id) {
                        subscribeTopics.push(`xiaozhi/${config.client_id}/#`);
                    } else {
                        subscribeTopics.push('xiaozhi/+/publish');
                    }
                }

                // 订阅所有相关 topic
                const subscribePromises = subscribeTopics.map(topic => {
                    return new Promise((resolve, reject) => {
                        this.mqttClient.subscribe(topic, { qos: 1 }, (err, granted) => {
                            if (err) {
                                console.error(`❌ Failed to subscribe to ${topic}:`, err);
                                reject(err);
                            } else {
                                const prefix = subscribeConfig.isFirstConnect ? '✅' : '🔄';
                                console.log(`${prefix} Subscribed to: ${topic}`, granted ? `(granted: ${JSON.stringify(granted)})` : '');
                                resolve();
                            }
                        });
                    });
                });

                // 也订阅通配符 topic 来监听所有消息（用于调试）
                subscribePromises.push(
                    new Promise((resolve, reject) => {
                        this.mqttClient.subscribe('#', { qos: 1 }, (err, granted) => {
                            if (err) {
                                console.error(`❌ Failed to subscribe to #:`, err);
                                console.warn('⚠️  Wildcard subscription failed, but continuing...');
                                resolve();
                            } else {
                                const prefix = subscribeConfig.isFirstConnect ? '✅' : '🔄';
                                console.log(`${prefix} Subscribed to: # (all topics - for debugging)`, granted ? `(granted: ${JSON.stringify(granted)})` : '');
                                resolve();
                            }
                        });
                    })
                );

                return Promise.all(subscribePromises);
            };

            this.mqttClient.on('connect', (connack) => {
                const isReconnect = !subscribeConfig.isFirstConnect;
                console.log(isReconnect ? '🔄 MQTT reconnected' : '✅ MQTT connected');
                if (connack) {
                    console.log(`   Return code: ${connack.returnCode}, Session present: ${connack.sessionPresent}`);
                    if (connack.returnCode !== 0) {
                        console.error(`❌ Connection refused with return code: ${connack.returnCode}`);
                        return;
                    }
                }
                
                // 检查连接状态
                if (!this.mqttClient || !this.mqttClient.connected) {
                    console.warn('⚠️  Client not connected after connect event');
                    return;
                }
                
                // 延迟订阅，确保连接稳定
                setTimeout(() => {
                    if (!this.mqttClient || !this.mqttClient.connected) {
                        console.warn('⚠️  Connection lost before subscription');
                        return;
                    }
                    
                    console.log('📡 Starting subscription...');
                    doSubscribe().then(() => {
                        if (subscribeConfig.isFirstConnect) {
                            console.log('\n📡 Listening for messages on all subscribed topics...');
                            console.log(`💾 Saved publish_topic: ${this.publishTopic}`);
                            console.log('💡 Trigger a conversation on the device to see conversation stats\n');
                            subscribeConfig.isFirstConnect = false;
                            resolve();
                        } else {
                            console.log('🔄 Resubscribed to all topics');
                        }
                    }).catch((error) => {
                        console.error('❌ Subscription error:', error.message);
                        console.warn('⚠️  Some subscriptions may have failed, but continuing...');
                        if (subscribeConfig.isFirstConnect) {
                            subscribeConfig.isFirstConnect = false;
                            resolve();
                        }
                    });
                }, 1000); // 延迟 1 秒再订阅，确保连接稳定
            });

            this.mqttClient.on('message', (topic, message) => {
                this.stats.mqttMessages++;
                
                // 检查是否是设备发布的消息（device-server topic）
                const isDevicePublish = topic === this.publishTopic;
                
                console.log('\n📥 MQTT message received:');
                console.log('   Topic:', topic);
                console.log('   Expected publish topic:', this.publishTopic);
                console.log('   Topic match:', topic === this.publishTopic ? '✅ MATCH' : '❌ NO MATCH');
                console.log('   Is device publish:', isDevicePublish ? '✅ YES' : '❌ NO');
                console.log('   Raw message length:', message.toString().length, 'bytes');
                
                // 如果是设备发布的消息，完整显示
                if (isDevicePublish) {
                    console.log('   ⭐⭐ DEVICE PUBLISHED MESSAGE ⭐⭐');
                    console.log('   Full message:', message.toString());
                } else {
                    console.log('   Raw message:', message.toString().substring(0, 500) + (message.toString().length > 500 ? '...' : ''));
                }
                
                try {
                    const data = JSON.parse(message.toString());
                    console.log('   Message type:', data.type);
                    
                    // 如果是设备发布的消息，特别标记
                    if (isDevicePublish) {
                        console.log('   ⭐ This is a message published by the device!');
                    }
                    
                    // 处理对话统计消息
                    if (data.type === 'conversation_stats') {
                        this.stats.conversationStats++;
                        console.log('✅✅✅ CONVERSATION STATS DETECTED! ✅✅✅');
                        console.log('   Session ID:', data.session_id);
                        console.log('   Duration:', data.duration?.toFixed(2) + 's');
                        console.log('   Reason:', data.reason);
                        console.log('   Timestamp:', new Date(data.timestamp * 1000).toLocaleString());
                        
                        this.broadcastToWebSocket(data);
                    } else {
                        // 其他消息类型
                        if (isDevicePublish) {
                            console.log('⚠️  Device published message but type is:', data.type);
                            console.log('   Full message:', JSON.stringify(data, null, 2));
                            
                            // 如果消息包含 conversation_stats 相关信息，也尝试转发
                            if (data.duration !== undefined && data.session_id) {
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
                        } else {
                            // 服务器发送的消息，只简单记录
                            console.log('   (Server message, type:', data.type + ')');
                        }
                    }
                } catch (e) {
                    console.error('❌ Error parsing MQTT message:', e.message);
                    console.error('   Raw message:', message.toString());
                }
            });

            this.mqttClient.on('error', (error) => {
                console.error('❌ MQTT error:', error.message);
                reject(error);
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

            this.mqttClient.on('end', () => {
                console.log('⚠️  MQTT client ended');
            });

            // 监听断开连接的原因
            if (this.mqttClient.stream) {
                this.mqttClient.stream.on('error', (error) => {
                    console.error('❌ MQTT stream error:', error.message);
                });
                this.mqttClient.stream.on('close', () => {
                    console.log('⚠️  MQTT stream closed');
                });
            }

            // 监听所有错误（这个已经在上面定义了，但为了完整性保留）
            // 注意：error 事件已经在上面处理了
        });
    }

    /**
     * 启动 WebSocket 服务器
     */
    startWebSocketServer(port) {
        this.wss = new WebSocket.Server({ port });

        this.wss.on('connection', (ws, req) => {
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

            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message.toString());
                    if (data.type === 'ping') {
                        ws.send(JSON.stringify({ type: 'pong' }));
                    }
                } catch (e) {
                    console.error('❌ Error parsing WebSocket message:', e.message);
                }
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
     * 设置 HTTP API 路由
     */
    setupHttpApi() {
        // 解析 JSON body
        this.app.use(express.json());

        // 健康检查
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                mqtt: {
                    connected: this.mqttClient?.connected || false
                },
                websocket: {
                    clients: this.stats.websocketClients
                },
                stats: this.stats
            });
        });

        // 添加设备
        this.app.post('/api/add-device', async (req, res) => {
            const { deviceId, clientId } = req.body;
            
            if (!deviceId || !clientId) {
                return res.status(400).json({
                    success: false,
                    error: 'deviceId and clientId are required'
                });
            }

            const result = await this.addDevice(deviceId, clientId);
            res.json(result);
        });

        // 获取统计信息
        this.app.get('/api/stats', (req, res) => {
            res.json({
                mqtt: {
                    connected: this.mqttClient?.connected || false,
                    endpoint: this.mqttConfig?.endpoint
                },
                websocket: {
                    clients: this.stats.websocketClients
                },
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

        // 测试发布消息（用于调试）
        this.app.post('/api/test-publish', (req, res) => {
            if (!this.mqttClient || !this.mqttClient.connected) {
                return res.status(400).json({ success: false, error: 'MQTT not connected' });
            }
            const { topic, message } = req.body;
            if (!topic || !message) {
                return res.status(400).json({ success: false, error: 'topic and message are required' });
            }
            this.mqttClient.publish(topic, JSON.stringify(message), { qos: 1 }, (err) => {
                if (err) {
                    res.json({ success: false, error: err.message });
                } else {
                    res.json({ success: true, message: 'Message published' });
                }
            });
        });
    }

    /**
     * 启动服务
     */
    async start() {
        // 启动 WebSocket 服务器
        this.startWebSocketServer(this.options.webSocketPort);

        // 设置 HTTP API
        this.setupHttpApi();

        // 启动 HTTP 服务器
        this.app.listen(this.options.httpPort, () => {
            console.log(`✅ HTTP API server listening on http://localhost:${this.options.httpPort}`);
            console.log(`📖 API endpoints:`);
            console.log(`   GET  /health - Health check`);
            console.log(`   POST /api/add-device - Add device`);
            console.log(`   GET  /api/stats - Get statistics`);
            console.log(`   GET  /api/devices - List devices`);
        });
    }
}

// 主程序
async function main() {
    const bridge = new AutoBridge({
        webSocketPort: process.env.WS_PORT || 8080,
        httpPort: process.env.HTTP_PORT || 3000,
        otaApiUrl: process.env.OTA_API_URL || 'https://api.tenclass.net/xiaozhi/ota/',
        boardType: process.env.BOARD_TYPE || 'longancore-s3',
        boardName: process.env.BOARD_NAME || 'longancore-s3'
    });

    // 从命令行参数或环境变量获取设备信息
    const deviceId = process.argv[2] || process.env.DEVICE_ID;
    const clientId = process.argv[3] || process.env.CLIENT_ID;

    try {
        await bridge.start();

        // 如果提供了设备信息，自动添加设备
        if (deviceId && clientId) {
            console.log('\n🚀 Auto-adding device...');
            const result = await bridge.addDevice(deviceId, clientId);
            if (result.success) {
                console.log('✅ Device added successfully!');
            } else {
                console.error('❌ Failed to add device:', result.error);
                console.log('\n💡 You can add devices later via HTTP API:');
                console.log(`   curl -X POST http://localhost:${bridge.options.httpPort}/api/add-device \\`);
                console.log('     -H "Content-Type: application/json" \\');
                console.log('     -d \'{"deviceId":"YOUR_DEVICE_ID","clientId":"YOUR_CLIENT_ID"}\'');
            }
        } else {
            console.log('\n💡 No device specified. Add devices via HTTP API:');
            console.log(`   curl -X POST http://localhost:${bridge.options.httpPort}/api/add-device \\`);
            console.log('     -H "Content-Type: application/json" \\');
            console.log('     -d \'{"deviceId":"YOUR_DEVICE_ID","clientId":"YOUR_CLIENT_ID"}\'');
            console.log('\n   Or set environment variables:');
            console.log('     DEVICE_ID=your_device_id CLIENT_ID=your_client_id npm start');
        }

        console.log('\n✨ Bridge service is running!');
        console.log(`   WebSocket: ws://localhost:${bridge.options.webSocketPort}`);
        console.log(`   HTTP API:  http://localhost:${bridge.options.httpPort}`);

    } catch (error) {
        console.error('❌ Failed to start bridge:', error);
        process.exit(1);
    }
}

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled rejection:', reason);
});

// 启动
if (require.main === module) {
    main();
}

module.exports = AutoBridge;

