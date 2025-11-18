#!/bin/bash

# 小智AI MQTT 到 WebSocket 桥接服务启动脚本

echo "🚀 启动小智AI MQTT 到 WebSocket 桥接服务"
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

# 检查是否提供了设备信息
if [ -z "$1" ] || [ -z "$2" ]; then
    echo "💡 使用方法:"
    echo "   ./start.sh <deviceId> <clientId>"
    echo ""
    echo "   示例:"
    echo "   ./start.sh e4:b0:63:85:96:00 de89ac1a-9f83-4557-a6f5-f25773bf3dd4"
    echo ""
    echo "   或者设置环境变量:"
    echo "   export DEVICE_ID=e4:b0:63:85:96:00"
    echo "   export CLIENT_ID=de89ac1a-9f83-4557-a6f5-f25773bf3dd4"
    echo "   ./start.sh"
    echo ""
    echo "🚀 启动服务（不添加设备，稍后通过 API 添加）..."
    echo ""
    npm start
else
    echo "🚀 启动服务并添加设备..."
    echo "   设备ID: $1"
    echo "   客户端ID: $2"
    echo ""
    npm start "$1" "$2"
fi

