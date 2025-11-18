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
            dataFile: options.dataFile || path.join(__dirname, 'conversations.json')
        };
        
        // 加载历史数据
        this.loadConversations();
        
        this.setupExpress();
    }

    /**
     * 配置 Express 应用
     */
    setupExpress() {
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
            
            const { session_id, duration, reason, timestamp } = req.body;
            
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

            const conversation = {
                sessionId: session_id || 'unknown',
                duration: duration,
                reason: reason || 'unknown',
                timestamp: validTimestamp,
                receivedAt: Date.now()
            };

            console.log('📊 Received conversation stats:', {
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

        // 获取所有对话统计
        this.app.get('/api/conversations', (req, res) => {
            const { limit = 100, offset = 0 } = req.query;
            const start = parseInt(offset);
            const end = start + parseInt(limit);
            
            res.json({
                success: true,
                total: this.conversations.length,
                conversations: this.conversations.slice(start, end),
                stats: {
                    totalConversations: this.stats.totalConversations,
                    totalDuration: this.stats.totalDuration,
                    averageDuration: this.stats.totalConversations > 0 
                        ? this.stats.totalDuration / this.stats.totalConversations 
                        : 0
                }
            });
        });

        // 获取统计摘要
        this.app.get('/api/stats', (req, res) => {
            const maxDuration = this.conversations.length > 0
                ? Math.max(...this.conversations.map(c => c.duration))
                : 0;

            res.json({
                success: true,
                stats: {
                    totalConversations: this.stats.totalConversations,
                    totalDuration: this.stats.totalDuration,
                    averageDuration: this.stats.totalConversations > 0
                        ? this.stats.totalDuration / this.stats.totalConversations
                        : 0,
                    maxDuration: maxDuration,
                    websocketClients: this.stats.websocketClients,
                    apiRequests: this.stats.apiRequests
                },
                conversations: this.conversations.slice(0, 10) // 最近10条
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
     * 启动 WebSocket 服务器
     */
    startWebSocketServer(port) {
        this.wss = new WebSocket.Server({ port });

        this.wss.on('connection', (ws) => {
            this.stats.websocketClients++;
            console.log(`📱 WebSocket client connected (total: ${this.stats.websocketClients})`);

            // 发送欢迎消息和当前统计
            ws.send(JSON.stringify({
                type: 'welcome',
                message: 'Connected to Xiaozhi API Bridge',
                stats: {
                    totalConversations: this.stats.totalConversations,
                    totalDuration: this.stats.totalDuration,
                    averageDuration: this.stats.totalConversations > 0
                        ? this.stats.totalDuration / this.stats.totalConversations
                        : 0
                }
            }));

            // 发送最近的对话统计
            if (this.conversations.length > 0) {
                this.conversations.slice(0, 10).forEach(conv => {
                    ws.send(JSON.stringify({
                        type: 'conversation_stats',
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
            console.log('   GET  /api/conversations - Get all conversations');
            console.log('   GET  /api/stats - Get statistics summary');
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
    console.log('   Example:');
    console.log('   curl -X POST http://localhost:3000/api/conversation-stats \\');
    console.log('     -H "Content-Type: application/json" \\');
    console.log('     -d \'{"session_id":"test-123","duration":10.5,"reason":"test","timestamp":1234567890}\'');
}

// 运行主程序
main().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});

