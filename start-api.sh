#!/bin/bash

# 小智AI HTTP API 桥接服务启动脚本

echo "🚀 启动小智AI HTTP API 桥接服务"
echo ""

# 检查 Node.js 是否安装
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 未找到 Node.js，请先安装 Node.js"
    echo "   访问 https://nodejs.org/ 下载安装"
    exit 1
fi

# 检查是否已安装依赖
if [ ! -d "node_modules" ]; then
    echo "📦 安装依赖..."
    npm install
    echo ""
fi

echo "🚀 启动 HTTP API 桥接服务..."
echo ""
node api-bridge.js

