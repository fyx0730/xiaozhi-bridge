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
const Database = require('better-sqlite3');

class ApiBridge {
    constructor(options = {}) {
        this.app = express();
        this.wss = null;
        this.conversations = []; // 内存缓存（最近1000条）
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
            dbPath: options.dbPath || path.join(__dirname, 'xiaozhi_bridge.db'),
            // 保留 JSON 文件路径用于迁移
            dataFile: options.dataFile || path.join(__dirname, 'conversations.json'),
            deviceNamesFile: options.deviceNamesFile || path.join(__dirname, 'device-names.json')
        };
        
        // 设备名称映射 { deviceId: deviceName }
        this.deviceNames = new Map();
        
        // 初始化 SQLite 数据库
        this.initDatabase();
        
        // 迁移旧数据（如果存在 JSON 文件）
        this.migrateFromJSON();
        
        // 加载设备名称（从数据库）
        this.loadDeviceNames();
        
        // 加载统计信息（从数据库）
        this.loadStats();
        
        // 加载最近1000条对话到内存缓存
        this.loadRecentConversations();
        
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

        // 处理对话统计的函数（可被多个路由使用）
        const handleConversationStats = (req, res) => {
            this.stats.apiRequests++;
            
            // 记录原始请求数据（用于调试）
            console.log('📥 Raw request data:', {
                path: req.path,
                headers: {
                    'device-id': req.headers['device-id'],
                    'device_id': req.headers['device_id'],
                    'x-device-id': req.headers['x-device-id'],
                    'user-agent': req.headers['user-agent']
                },
                body: req.body
            });
            
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

            // 设备 ID 获取优先级：
            // 1. 请求体中的 device_id
            // 2. HTTP Header 中的 Device-Id 或 X-Device-Id
            // 3. 如果都没有，拒绝请求（禁止 unknown 设备）
            let deviceId = device_id || 
                          req.headers['device-id'] || 
                          req.headers['device_id'] || 
                          req.headers['x-device-id'];
            
            // 如果没有 device_id，拒绝请求
            if (!deviceId) {
                console.warn('⚠️  No device_id found in request body or headers, rejecting request');
                return res.status(400).json({ 
                    success: false, 
                    error: 'device_id is required. Please provide device_id in request body or Device-Id header.' 
                });
            }
            
            // 记录设备ID来源
            const source = device_id ? 'request body' : 
                          (req.headers['device-id'] || req.headers['device_id'] || req.headers['x-device-id']) ? 'HTTP header' : 'unknown';
            console.log(`📱 Device ID: ${deviceId} (from ${source})`);

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

            // 返回响应，不包含 deviceId，防止设备端读取并重置设备ID
            res.json({ 
                success: true, 
                message: 'Conversation stats received',
                sessionId: conversation.sessionId,
                timestamp: conversation.timestamp
            });
        };

        // 注册两个路由以兼容不同的部署配置
        // 1. /api/conversation-stats - 标准路径
        this.app.post('/api/conversation-stats', handleConversationStats);
        
        // 2. /conversation-stats - 备用路径（用于反向代理去掉 /api 前缀的情况）
        this.app.post('/conversation-stats', handleConversationStats);

        // 获取所有对话统计（支持按设备筛选）
        this.app.get('/api/conversations', (req, res) => {
            try {
                const { limit = 100, offset = 0, device_id } = req.query;
                const limitNum = parseInt(limit);
                const offsetNum = parseInt(offset);
                
                // 构建查询
                let query = `
                    SELECT 
                        device_id as deviceId,
                        session_id as sessionId,
                        duration,
                        reason,
                        timestamp,
                        received_at as receivedAt
                    FROM conversations
                `;
                const params = [];
                
                if (device_id) {
                    query += ' WHERE device_id = ?';
                    params.push(device_id);
                }
                
                query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
                params.push(limitNum, offsetNum);
                
                const stmt = this.db.prepare(query);
                const conversations = stmt.all(...params);
                
                // 获取总数和统计
                let countQuery = 'SELECT COUNT(*) as total, COALESCE(SUM(duration), 0) as totalDuration FROM conversations';
                const countParams = [];
                if (device_id) {
                    countQuery += ' WHERE device_id = ?';
                    countParams.push(device_id);
                }
                
                const countStmt = this.db.prepare(countQuery);
                const countResult = countStmt.get(...countParams);
                
                res.json({
                    success: true,
                    total: countResult.total,
                    conversations: conversations,
                    stats: {
                        totalConversations: countResult.total,
                        totalDuration: countResult.totalDuration,
                        averageDuration: countResult.total > 0 
                            ? countResult.totalDuration / countResult.total 
                            : 0
                    },
                    device_id: device_id || null
                });
            } catch (error) {
                console.error('❌ Failed to get conversations:', error.message);
                res.status(500).json({
                    success: false,
                    error: 'Failed to get conversations'
                });
            }
        });

        // 处理设备列表的函数（可被多个路由使用）
        const handleGetDevices = (req, res) => {
            try {
                const stmt = this.db.prepare(`
                    SELECT 
                        device_id,
                        COUNT(*) as totalConversations,
                        SUM(duration) as totalDuration,
                        MAX(timestamp) as lastTimestamp
                    FROM conversations
                    WHERE device_id IS NOT NULL AND device_id != ''
                    GROUP BY device_id
                    ORDER BY lastTimestamp DESC
                `);
                
                const deviceStats = stmt.all();
                
                // 获取每个设备的最后一条对话
                const devices = deviceStats.map(stat => {
                    const lastConvStmt = this.db.prepare(`
                        SELECT session_id, timestamp
                        FROM conversations
                        WHERE device_id = ? AND timestamp = ?
                        LIMIT 1
                    `);
                    const lastConv = lastConvStmt.get(stat.device_id, stat.lastTimestamp);
                    
                    return {
                        deviceId: stat.device_id,
                        deviceName: this.deviceNames.get(stat.device_id) || null,
                        totalConversations: stat.totalConversations,
                        totalDuration: stat.totalDuration,
                        averageDuration: stat.totalConversations > 0 
                            ? stat.totalDuration / stat.totalConversations 
                            : 0,
                        lastConversation: lastConv ? {
                            sessionId: lastConv.session_id,
                            timestamp: lastConv.timestamp
                        } : null
                    };
                });
                
                res.json({
                    success: true,
                    devices: devices,
                    totalDevices: devices.length
                });
            } catch (error) {
                console.error('❌ Failed to get devices:', error.message);
                res.status(500).json({
                    success: false,
                    error: 'Failed to get devices'
                });
            }
        };

        // 注册两个路由以兼容不同的部署配置
        this.app.get('/api/devices', handleGetDevices);
        this.app.get('/devices', handleGetDevices);

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
            this.saveDeviceName(deviceId, trimmedName);
            
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
                this.deleteDeviceName(deviceId);
                
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
            try {
                const { deviceId } = req.params;
                
                // 获取统计信息
                const statsStmt = this.db.prepare(`
                    SELECT 
                        COUNT(*) as totalConversations,
                        COALESCE(SUM(duration), 0) as totalDuration,
                        COALESCE(AVG(duration), 0) as averageDuration,
                        COALESCE(MAX(duration), 0) as maxDuration
                    FROM conversations
                    WHERE device_id = ?
                `);
                
                const stats = statsStmt.get(deviceId);
                
                if (stats.totalConversations === 0) {
                    return res.status(404).json({
                        success: false,
                        error: 'Device not found'
                    });
                }
                
                // 获取最近10条对话
                const conversationsStmt = this.db.prepare(`
                    SELECT 
                        device_id as deviceId,
                        session_id as sessionId,
                        duration,
                        reason,
                        timestamp,
                        received_at as receivedAt
                    FROM conversations
                    WHERE device_id = ?
                    ORDER BY timestamp DESC
                    LIMIT 10
                `);
                
                const conversations = conversationsStmt.all(deviceId);
                
                res.json({
                    success: true,
                    deviceId: deviceId,
                    stats: {
                        totalConversations: stats.totalConversations,
                        totalDuration: stats.totalDuration,
                        averageDuration: stats.averageDuration,
                        maxDuration: stats.maxDuration
                    },
                    conversations: conversations
                });
            } catch (error) {
                console.error('❌ Failed to get device stats:', error.message);
                res.status(500).json({
                    success: false,
                    error: 'Failed to get device stats'
                });
            }
        });

        // 删除设备（删除该设备的所有对话记录和设备名称）
        this.app.delete('/api/devices/:deviceId', (req, res) => {
            try {
                const { deviceId } = req.params;
                
                // 获取要删除的对话统计
                const countStmt = this.db.prepare(`
                    SELECT COUNT(*) as count, COALESCE(SUM(duration), 0) as totalDuration
                    FROM conversations
                    WHERE device_id = ?
                `);
                const countResult = countStmt.get(deviceId);
                const deletedCount = countResult.count;
                const deletedDuration = countResult.totalDuration;
                
                // 删除该设备的所有对话记录
                const deleteStmt = this.db.prepare('DELETE FROM conversations WHERE device_id = ?');
                deleteStmt.run(deviceId);
                
                // 更新统计
                this.stats.totalConversations -= deletedCount;
                this.stats.totalDuration -= deletedDuration;
                
                // 更新内存缓存
                this.conversations = this.conversations.filter(c => c.deviceId !== deviceId);
                
                // 删除设备名称（如果存在）
                let deviceNameDeleted = false;
                if (this.deviceNames.has(deviceId)) {
                    this.deleteDeviceName(deviceId);
                    deviceNameDeleted = true;
                }
                
                console.log(`🗑️  Deleted device: ${deviceId} (${deletedCount} conversations, ${deviceNameDeleted ? 'name removed' : 'no name'})`);
                
                res.json({
                    success: true,
                    deviceId: deviceId,
                    deletedConversations: deletedCount,
                    deletedDuration: deletedDuration,
                    deviceNameDeleted: deviceNameDeleted,
                    message: `Device deleted: ${deletedCount} conversations removed`
                });
            } catch (error) {
                console.error('❌ Failed to delete device:', error.message);
                res.status(500).json({
                    success: false,
                    error: 'Failed to delete device'
                });
            }
        });

        // 获取统计摘要（支持按设备筛选）
        this.app.get('/api/stats', (req, res) => {
            try {
                const { device_id } = req.query;
                
                // 构建统计查询
                let statsQuery = `
                    SELECT 
                        COUNT(*) as totalConversations,
                        COALESCE(SUM(duration), 0) as totalDuration,
                        COALESCE(AVG(duration), 0) as averageDuration,
                        COALESCE(MAX(duration), 0) as maxDuration
                    FROM conversations
                `;
                const statsParams = [];
                
                if (device_id) {
                    statsQuery += ' WHERE device_id = ?';
                    statsParams.push(device_id);
                }
                
                const statsStmt = this.db.prepare(statsQuery);
                const stats = statsStmt.get(...statsParams);
                
                // 获取设备列表统计
                const deviceStmt = this.db.prepare(`
                    SELECT 
                        device_id,
                        COUNT(*) as totalConversations,
                        SUM(duration) as totalDuration
                    FROM conversations
                    WHERE device_id IS NOT NULL AND device_id != ''
                    GROUP BY device_id
                `);
                const deviceStats = deviceStmt.all();
                
                // 获取最近10条对话
                let conversationsQuery = `
                    SELECT 
                        device_id as deviceId,
                        session_id as sessionId,
                        duration,
                        reason,
                        timestamp,
                        received_at as receivedAt
                    FROM conversations
                `;
                const conversationsParams = [];
                
                if (device_id) {
                    conversationsQuery += ' WHERE device_id = ?';
                    conversationsParams.push(device_id);
                }
                
                conversationsQuery += ' ORDER BY timestamp DESC LIMIT 10';
                
                const conversationsStmt = this.db.prepare(conversationsQuery);
                const conversations = conversationsStmt.all(...conversationsParams);

                res.json({
                    success: true,
                    stats: {
                        totalConversations: stats.totalConversations,
                        totalDuration: stats.totalDuration,
                        averageDuration: stats.averageDuration,
                        maxDuration: stats.maxDuration,
                        websocketClients: this.stats.websocketClients,
                        apiRequests: this.stats.apiRequests,
                        totalDevices: deviceStats.length
                    },
                    conversations: conversations,
                    device_id: device_id || null,
                    devices: deviceStats.map(stat => ({
                        deviceId: stat.device_id,
                        deviceName: this.deviceNames.get(stat.device_id) || null,
                        totalConversations: stat.totalConversations,
                        totalDuration: stat.totalDuration
                    }))
                });
            } catch (error) {
                console.error('❌ Failed to get stats:', error.message);
                res.status(500).json({
                    success: false,
                    error: 'Failed to get stats'
                });
            }
        });

        // 清空所有数据
        this.app.delete('/api/conversations', (req, res) => {
            try {
                // 清空数据库
                this.db.exec('DELETE FROM conversations');
                
                // 清空内存缓存和统计
                this.conversations = [];
                this.stats.totalConversations = 0;
                this.stats.totalDuration = 0;
                
                res.json({ 
                    success: true, 
                    message: 'All conversations cleared' 
                });
            } catch (error) {
                console.error('❌ Failed to clear conversations:', error.message);
                res.status(500).json({
                    success: false,
                    error: 'Failed to clear conversations'
                });
            }
        });
    }

    /**
     * 初始化 SQLite 数据库
     */
    initDatabase() {
        try {
            this.db = new Database(this.options.dbPath);
            
            // 创建 conversations 表
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS conversations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    duration REAL NOT NULL,
                    reason TEXT,
                    timestamp INTEGER NOT NULL,
                    received_at INTEGER NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                
                CREATE INDEX IF NOT EXISTS idx_conversations_device_id 
                    ON conversations(device_id);
                CREATE INDEX IF NOT EXISTS idx_conversations_timestamp 
                    ON conversations(timestamp DESC);
                CREATE INDEX IF NOT EXISTS idx_conversations_session_id 
                    ON conversations(session_id);
            `);
            
            // 创建 device_names 表
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS device_names (
                    device_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);
            
            console.log('✅ SQLite database initialized');
        } catch (error) {
            console.error('❌ Failed to initialize database:', error.message);
            throw error;
        }
    }

    /**
     * 从 JSON 文件迁移数据到 SQLite（一次性迁移）
     */
    migrateFromJSON() {
        try {
            // 检查是否已经迁移过（检查数据库中是否有数据）
            const checkStmt = this.db.prepare('SELECT COUNT(*) as count FROM conversations');
            const dbCount = checkStmt.get().count;
            
            if (dbCount > 0) {
                console.log(`📊 Database already has ${dbCount} conversations, skipping migration`);
                return;
            }
            
            // 迁移对话数据
            if (fs.existsSync(this.options.dataFile)) {
                const data = JSON.parse(fs.readFileSync(this.options.dataFile, 'utf8'));
                const conversations = data.conversations || [];
                
                if (conversations.length > 0) {
                    const insertStmt = this.db.prepare(`
                        INSERT INTO conversations 
                        (device_id, session_id, duration, reason, timestamp, received_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `);
                    
                    const insertMany = this.db.transaction((convs) => {
                        for (const conv of convs) {
                            insertStmt.run(
                                conv.deviceId || 'unknown',
                                conv.sessionId || 'unknown',
                                conv.duration || 0,
                                conv.reason || 'unknown',
                                conv.timestamp || Math.floor(Date.now() / 1000),
                                conv.receivedAt || Date.now()
                            );
                        }
                    });
                    
                    insertMany(conversations);
                    console.log(`✅ Migrated ${conversations.length} conversations from JSON to SQLite`);
                }
            }
            
            // 迁移设备名称
            if (fs.existsSync(this.options.deviceNamesFile)) {
                const data = JSON.parse(fs.readFileSync(this.options.deviceNamesFile, 'utf8'));
                const deviceNames = Object.entries(data);
                
                if (deviceNames.length > 0) {
                    const insertStmt = this.db.prepare(`
                        INSERT OR REPLACE INTO device_names (device_id, name, updated_at)
                        VALUES (?, ?, CURRENT_TIMESTAMP)
                    `);
                    
                    const insertMany = this.db.transaction((names) => {
                        for (const [deviceId, name] of names) {
                            insertStmt.run(deviceId, name);
                        }
                    });
                    
                    insertMany(deviceNames);
                    console.log(`✅ Migrated ${deviceNames.length} device names from JSON to SQLite`);
                }
            }
        } catch (error) {
            console.error('❌ Failed to migrate data from JSON:', error.message);
            // 不抛出错误，允许服务继续运行
        }
    }

    /**
     * 加载统计信息（从数据库）
     */
    loadStats() {
        try {
            const stmt = this.db.prepare(`
                SELECT 
                    COUNT(*) as totalConversations,
                    COALESCE(SUM(duration), 0) as totalDuration
                FROM conversations
            `);
            const result = stmt.get();
            
            this.stats.totalConversations = result.totalConversations || 0;
            this.stats.totalDuration = result.totalDuration || 0;
            
            console.log(`📊 Loaded stats: ${this.stats.totalConversations} conversations, ${this.stats.totalDuration.toFixed(2)}s total duration`);
        } catch (error) {
            console.error('❌ Failed to load stats:', error.message);
        }
    }

    /**
     * 加载最近1000条对话到内存缓存
     */
    loadRecentConversations() {
        try {
            const stmt = this.db.prepare(`
                SELECT 
                    device_id as deviceId,
                    session_id as sessionId,
                    duration,
                    reason,
                    timestamp,
                    received_at as receivedAt
                FROM conversations
                ORDER BY timestamp DESC
                LIMIT 1000
            `);
            
            this.conversations = stmt.all();
            console.log(`📂 Loaded ${this.conversations.length} recent conversations into memory cache`);
        } catch (error) {
            console.error('❌ Failed to load recent conversations:', error.message);
            this.conversations = [];
        }
    }

    /**
     * 添加对话统计
     */
    addConversation(conversation) {
        try {
            // 保存到数据库
            const insertStmt = this.db.prepare(`
                INSERT INTO conversations 
                (device_id, session_id, duration, reason, timestamp, received_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            
            insertStmt.run(
                conversation.deviceId || 'unknown',
                conversation.sessionId || 'unknown',
                conversation.duration || 0,
                conversation.reason || 'unknown',
                conversation.timestamp || Math.floor(Date.now() / 1000),
                conversation.receivedAt || Date.now()
            );
            
            // 更新内存缓存（最近1000条）
            this.conversations.unshift(conversation);
            if (this.conversations.length > 1000) {
                this.conversations.pop();
            }
            
            // 更新统计
            this.stats.totalConversations++;
            this.stats.totalDuration += conversation.duration;
        } catch (error) {
            console.error('❌ Failed to add conversation to database:', error.message);
            // 仍然更新内存缓存，即使数据库操作失败
            this.conversations.unshift(conversation);
            if (this.conversations.length > 1000) {
                this.conversations.pop();
            }
        }
    }

    /**
     * 加载设备名称（从数据库）
     */
    loadDeviceNames() {
        try {
            const stmt = this.db.prepare('SELECT device_id, name FROM device_names');
            const rows = stmt.all();
            
            this.deviceNames = new Map(rows.map(row => [row.device_id, row.name]));
            console.log(`✅ Loaded ${this.deviceNames.size} device names from database`);
        } catch (error) {
            console.error('❌ Failed to load device names:', error.message);
            this.deviceNames = new Map();
        }
    }

    /**
     * 保存设备名称（到数据库）
     */
    saveDeviceName(deviceId, name) {
        try {
            const stmt = this.db.prepare(`
                INSERT INTO device_names (device_id, name, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(device_id) DO UPDATE SET
                    name = excluded.name,
                    updated_at = CURRENT_TIMESTAMP
            `);
            
            stmt.run(deviceId, name);
            this.deviceNames.set(deviceId, name);
        } catch (error) {
            console.error('❌ Failed to save device name:', error.message);
            throw error;
        }
    }

    /**
     * 删除设备名称（从数据库）
     */
    deleteDeviceName(deviceId) {
        try {
            const stmt = this.db.prepare('DELETE FROM device_names WHERE device_id = ?');
            stmt.run(deviceId);
            this.deviceNames.delete(deviceId);
        } catch (error) {
            console.error('❌ Failed to delete device name:', error.message);
            throw error;
        }
    }

    /**
     * 启动 WebSocket 服务器
     */
    startWebSocketServer(port) {
        this.wss = new WebSocket.Server({ port });

        this.wss.on('connection', (ws, req) => {
            this.stats.websocketClients++;
            console.log(`📱 WebSocket client connected (total: ${this.stats.websocketClients})`);

            // 心跳机制：定期发送 ping 保持连接
            let pingInterval = null;
            let pongTimeout = null;
            let isAlive = true;

            // 设置心跳间隔（每30秒发送一次 ping）
            pingInterval = setInterval(() => {
                if (isAlive === false) {
                    console.log('💔 WebSocket client did not respond to ping, closing connection');
                    clearInterval(pingInterval);
                    ws.terminate();
                    return;
                }

                isAlive = false;
                try {
                    // 使用 WebSocket ping frame（如果支持）
                    if (ws.isAlive !== undefined) {
                        ws.isAlive = false;
                        ws.ping();
                    } else {
                        // 如果不支持 ping frame，发送 JSON ping 消息
                        ws.send(JSON.stringify({ type: 'ping' }));
                    }
                } catch (error) {
                    console.error('❌ Failed to send ping:', error.message);
                    clearInterval(pingInterval);
                    ws.terminate();
                }
            }, 30000); // 30秒

            // 处理 pong 响应
            ws.on('pong', () => {
                isAlive = true;
                if (ws.isAlive !== undefined) {
                    ws.isAlive = true;
                }
            });

            // 获取设备列表统计（从数据库）
            const deviceStmt = this.db.prepare(`
                SELECT 
                    device_id,
                    COUNT(*) as totalConversations,
                    SUM(duration) as totalDuration
                FROM conversations
                WHERE device_id IS NOT NULL AND device_id != ''
                GROUP BY device_id
            `);
            const deviceStats = deviceStmt.all();

            // 过滤掉 unknown 设备（双重保护）
            const validDeviceStats = deviceStats.filter(stat => 
                stat.device_id && 
                stat.device_id !== 'unknown' && 
                stat.device_id !== '' && 
                stat.device_id !== null
            );

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
                    totalDevices: validDeviceStats.length
                },
                devices: validDeviceStats.map(stat => ({
                    deviceId: stat.device_id,
                    totalConversations: stat.totalConversations,
                    totalDuration: stat.totalDuration
                }))
            }));

            // 发送最近的对话统计（可选：可以通过查询参数控制是否发送历史数据）
            // 注意：如果数据库中有测试数据，每次连接都会收到
            // 可以通过添加 ?history=false 查询参数来禁用历史数据发送
            const sendHistory = req.url ? !req.url.includes('history=false') : true;
            
            if (sendHistory && this.conversations.length > 0) {
                // 只发送最近10条真实对话（排除测试数据）
                const realConversations = this.conversations
                    .filter(conv => 
                        conv.sessionId !== 'test-123' && 
                        conv.reason !== 'test' &&
                        conv.deviceId !== 'unknown'
                    )
                    .slice(0, 10);
                
                if (realConversations.length > 0) {
                    console.log(`📤 Sending ${realConversations.length} recent conversations to new client`);
                    realConversations.forEach(conv => {
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
            }

            // 处理客户端消息（包括 ping/pong）
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message.toString());
                    
                    // 处理客户端发送的 ping
                    if (data.type === 'ping') {
                        ws.send(JSON.stringify({ type: 'pong' }));
                        isAlive = true;
                        return;
                    }
                    
                    // 处理客户端发送的 pong
                    if (data.type === 'pong') {
                        isAlive = true;
                        return;
                    }
                } catch (error) {
                    // 如果不是 JSON 消息，忽略（可能是二进制数据）
                }
            });

            ws.on('close', (code, reason) => {
                this.stats.websocketClients--;
                if (pingInterval) {
                    clearInterval(pingInterval);
                }
                if (pongTimeout) {
                    clearTimeout(pongTimeout);
                }
                
                // 记录断开连接的详细信息
                const closeReason = reason ? reason.toString() : 'No reason provided';
                console.log(`📱 WebSocket client disconnected:`);
                console.log(`   Close code: ${code}`);
                console.log(`   Reason: ${closeReason}`);
                console.log(`   Total clients: ${this.stats.websocketClients}`);
                
                // 根据关闭代码判断断开原因
                if (code === 1000) {
                    console.log(`   💡 Normal closure (client initiated)`);
                } else if (code === 1001) {
                    console.log(`   💡 Going away (client is leaving)`);
                } else if (code === 1006) {
                    console.log(`   ⚠️  Abnormal closure (no close frame received)`);
                } else if (code === 1008) {
                    console.log(`   ⚠️  Policy violation`);
                } else if (code === 1011) {
                    console.log(`   ⚠️  Server error`);
                }
            });

            ws.on('error', (error) => {
                console.error('❌ WebSocket error:', error.message);
                if (pingInterval) {
                    clearInterval(pingInterval);
                }
                if (pongTimeout) {
                    clearTimeout(pongTimeout);
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
            console.log('   POST /api/conversation-stats - Receive conversation stats from device (standard path)');
            console.log('   POST /conversation-stats - Receive conversation stats from device (alternative path for reverse proxy)');
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

