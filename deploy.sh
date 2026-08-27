#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Hummingbird Camera System - Raspberry Pi 3 Deployment Script
# Target: Raspberry Pi 3 Model B (ARMv7) @ 192.168.1.252
# User: prodigy
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

INSTALL_DIR="/home/prodigy/hummingbird-camera"
PYTHON_VENV="$INSTALL_DIR/pi-local/venv"
SERVICE_NAME="hummingbird-camera"
DASHBOARD_SERVICE="hummingbird-dashboard"
SWAP_FILE="/home/prodigy/hummingbird-swap"
SWAP_SIZE="2G"  # 2 GB temporary swap for pip compilation

echo "═══════════════════════════════════════════════════════"
echo "  🐦 Hummingbird Camera System - Deployment"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── Step 0: Check Disk Space ─────────────────────────────────
echo "💾 Checking disk space..."
AVAILABLE_KB=$(df / | tail -1 | awk '{print $4}')
AVAILABLE_GB=$(echo "scale=1; $AVAILABLE_KB / 1024 / 1024" | bc)
echo "   Available: ${AVAILABLE_GB} GB"

if (( $(echo "$AVAILABLE_GB < 2.0" | bc -l) )); then
    echo "⚠️  Warning: Less than 2 GB disk space available!"
    echo "   Cleaning up package cache..."
    sudo apt-get clean
    sudo apt-get autoremove -y
    rm -rf ~/.cache/pip 2>/dev/null || true
    AVAILABLE_KB=$(df / | tail -1 | awk '{print $4}')
    AVAILABLE_GB=$(echo "scale=1; $AVAILABLE_KB / 1024 / 1024" | bc)
    echo "   After cleanup: ${AVAILABLE_GB} GB available"
fi
echo ""

# ── Step 1: Create Temporary Swap ────────────────────────────
echo "🔄 Creating temporary swap file (${SWAP_SIZE})..."
if [ -f "$SWAP_FILE" ]; then
    echo "   Swap file already exists, removing..."
    sudo swapoff "$SWAP_FILE" 2>/dev/null || true
    sudo rm -f "$SWAP_FILE"
fi

sudo fallocate -l "$SWAP_SIZE" "$SWAP_FILE"
sudo chmod 600 "$SWAP_FILE"
sudo mkswap "$SWAP_FILE" > /dev/null
sudo swapon "$SWAP_FILE"
echo "✅ Temporary swap activated"
echo ""

# ── Step 2: System Dependencies ──────────────────────────────
echo "📦 Installing system dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
    python3-full \
    python3-venv \
    python3-pip \
    python3-dev \
    python3-opencv \
    libopenjp2-7 \
    libhdf5-dev \
    cmake \
    git \
    jq

echo "✅ System dependencies installed"
echo ""

# ── Step 3: Copy Project Files ───────────────────────────────
echo "📁 Setting up project directory..."
mkdir -p "$INSTALL_DIR"

# Copy files (assumes script runs from project root)
cp -r pi-local/* "$INSTALL_DIR/pi-local/" 2>/dev/null || true
cp -r cloudflare-worker "$INSTALL_DIR/" 2>/dev/null || true
cp -r cloudflare-pages "$INSTALL_DIR/" 2>/dev/null || true
cp .env.example "$INSTALL_DIR/pi-local/.env" 2>/dev/null || true

# Create required directories
mkdir -p "$INSTALL_DIR/pi-local/captures"
mkdir -p "$INSTALL_DIR/pi-local/logs"
mkdir -p "$INSTALL_DIR/pi-local/app/models"

echo "✅ Project files copied to $INSTALL_DIR"
echo ""

# ── Step 4: Python Virtual Environment ───────────────────────
echo "🐍 Setting up Python virtual environment..."
cd "$INSTALL_DIR/pi-local"

if [ ! -d "$PYTHON_VENV" ]; then
    # Use --system-site-packages to access picamera2 and other system packages
    python3 -m venv --system-site-packages "$PYTHON_VENV"
fi

source "$PYTHON_VENV/bin/activate"
pip install --upgrade pip setuptools wheel
# OpenCV 5.x broke the DNN loaders this project needs - force 4.x
pip uninstall -y opencv-python opencv-contrib-python 2>/dev/null || true
pip install --no-cache-dir -r requirements.txt

echo "✅ Python environment ready"
echo ""

# ── Step 5: Download AI Model ────────────────────────────────
echo "🧠 Downloading SSD MobileNet v1 COCO model (~27 MB)..."
MODEL_DIR="$INSTALL_DIR/pi-local/app/models"
mkdir -p "$MODEL_DIR"

cd "$MODEL_DIR"

# SSD MobileNet v1 COCO frozen graph - the exact model from OpenCV's
# official DNN tutorial. IMPORTANT: must be the 2017_11_17 version -
# the 2018_01_28 version crashes OpenCV DNN's graph simplifier.
if [ ! -f "ssd_mobilenet_v1_coco.pb" ]; then
    wget -q http://download.tensorflow.org/models/object_detection/ssd_mobilenet_v1_coco_2017_11_17.tar.gz -O ssd_mobilenet_v1_coco.tar.gz
    tar -xzf ssd_mobilenet_v1_coco.tar.gz
    mv ssd_mobilenet_v1_coco_2017_11_17/frozen_inference_graph.pb ssd_mobilenet_v1_coco.pb
    rm -rf ssd_mobilenet_v1_coco_2017_11_17 ssd_mobilenet_v1_coco.tar.gz
fi

if [ ! -f "ssd_mobilenet_v1_coco.pbtxt" ]; then
    wget -q https://raw.githubusercontent.com/opencv/opencv_extra/master/testdata/dnn/ssd_mobilenet_v1_coco.pbtxt -O ssd_mobilenet_v1_coco.pbtxt
fi

echo "✅ SSD MobileNet v1 COCO model downloaded"
echo ""

# ── Step 6: Configure .env ───────────────────────────────────
echo "⚙️  Configuration..."
if [ -f "$INSTALL_DIR/pi-local/.env" ]; then
    echo "📝 .env file exists at $INSTALL_DIR/pi-local/.env"
    echo "   Please edit it with your Cloudflare credentials:"
    echo "   nano $INSTALL_DIR/pi-local/.env"
else
    cp "$INSTALL_DIR/pi-local/.env.example" "$INSTALL_DIR/pi-local/.env" 2>/dev/null || \
    cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/pi-local/.env" 2>/dev/null || true
    echo "⚠️  Created .env from template. Please edit with your credentials:"
    echo "   nano $INSTALL_DIR/pi-local/.env"
fi
echo ""

# ── Step 7: Systemd Service - Main Camera ────────────────────
echo "🔧 Creating systemd service for camera system..."
sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null << EOF
[Unit]
Description=Hummingbird Camera - AI Detection System
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=prodigy
Group=prodigy
WorkingDirectory=$INSTALL_DIR/pi-local
Environment=PATH=$PYTHON_VENV/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$PYTHON_VENV/bin/python main.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

# Resource limits for RPi 3
MemoryMax=800M
CPUQuota=80%

[Install]
WantedBy=multi-user.target
EOF

echo "✅ Camera service created"
echo ""

# ── Step 8: Systemd Service - Dashboard ──────────────────────
echo "🔧 Creating systemd service for web dashboard..."
sudo tee /etc/systemd/system/${DASHBOARD_SERVICE}.service > /dev/null << EOF
[Unit]
Description=Hummingbird Camera - Local Web Dashboard
After=network.target

[Service]
Type=simple
User=prodigy
Group=prodigy
WorkingDirectory=$INSTALL_DIR/pi-local
Environment=PATH=$PYTHON_VENV/bin:/usr/local/bin:/usr/bin:/bin
Environment=FLASK_HOST=0.0.0.0
Environment=FLASK_PORT=8080
ExecStart=$PYTHON_VENV/bin/python -c "from web.server import app; app.run(host='0.0.0.0', port=8080, debug=False)"
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "✅ Dashboard service created"
echo ""

# ── Step 9: Enable and Start Services ────────────────────────
echo "🚀 Enabling services..."
sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME} ${DASHBOARD_SERVICE}

# ── Step 10: Cleanup Temporary Swap ──────────────────────────
echo "🧹 Cleaning up temporary swap file..."
sudo swapoff "$SWAP_FILE" 2>/dev/null || true
sudo rm -f "$SWAP_FILE"
echo "✅ Temporary swap removed"
echo ""

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ Deployment Complete!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo ""
echo "1. Edit your .env configuration:"
echo "   nano $INSTALL_DIR/pi-local/.env"
echo ""
echo "2. Start the camera system:"
echo "   sudo systemctl start $SERVICE_NAME"
echo ""
echo "3. Start the web dashboard:"
echo "   sudo systemctl start $DASHBOARD_SERVICE"
echo ""
echo "4. Check status:"
echo "   sudo systemctl status $SERVICE_NAME"
echo "   sudo systemctl status $DASHBOARD_SERVICE"
echo ""
echo "5. View logs:"
echo "   journalctl -u $SERVICE_NAME -f"
echo ""
echo "6. Access the local dashboard:"
echo "   http://192.168.1.252:8080"
echo ""
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Cloudflare Deployment (run on your local machine):"
echo ""
echo "  cd $INSTALL_DIR/cloudflare-worker"
echo "  npx wrangler deploy"
echo ""
echo "  cd $INSTALL_DIR/cloudflare-pages"
echo "  npx wrangler pages deploy ."
echo ""
echo "═══════════════════════════════════════════════════════"
