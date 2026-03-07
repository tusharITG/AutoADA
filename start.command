#!/bin/bash
cd "$(dirname "$0")"
echo ""
echo "  Starting AutoADA Web UI..."
echo ""
sleep 1 && open http://localhost:3000 &
node src/server.js
