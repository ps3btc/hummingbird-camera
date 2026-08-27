# Hummingbird Camera System

An AI-powered, motion-triggered camera system for capturing hummingbirds and wildlife on a Raspberry Pi 3 Model B. Features local object detection with MobileNet-SSD, cloud storage via Cloudflare R2, a mobile-friendly detection gallery with analytics, and automated email alerts via Mailjet.

**Live Gallery**: https://hummingbird-gallery.pages.dev

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Raspberry Pi 3 Model B                    │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │   Camera     │→ │   Motion     │→ │   AI Detection   │  │
│  │   (NoIR)     │  │   Detection  │  │  (MobileNet-SSD) │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                               │              │
│                          ┌────────────────────┼──────────┐  │
│                          │                    │          │  │
│                          ▼                    ▼          ▼  │
│                   ┌─────────────┐    ┌──────────┐  ┌─────┐ │
│                   │  Upload to  │    │  Email   │  │Local│ │
│                   │  Cloudflare │    │  Alert   │  │Dash │ │
│                   │  R2         │    │(Mailjet) │  │board│ │
│                   └─────────────┘    └──────────┘  └─────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │      Cloudflare Platform      │
              │                               │
              │  ┌─────────┐  ┌────────────┐ │
              │  │   R2    │  │   Pages    │ │
              │  │ Storage │  │  Gallery   │ │
              │  └─────────┘  └────────────┘ │
              │       ↑                       │
              │  ┌─────────┐                 │
              │  │ Workers │                 │
              │  │  (API)  │                 │
              │  └─────────┘                 │
              └───────────────────────────────┘
```

## Features

- **Motion-Triggered Capture**: Automatically captures images when motion is detected
- **AI Object Detection**: Uses MobileNet-SSD via OpenCV DNN to detect birds, animals, and humans (~120ms inference on Pi 3)
- **Smart Routing**:
  - Any object detected → Upload to Cloudflare R2 with metadata
  - Animal/bird detected (no humans) → Send email alert via Mailjet
- **Cloud Gallery**: Mobile-friendly web app with:
  - Detection gallery with filter buttons (All/Birds/Animals/Humans)
  - Category toggle switches (humans hidden by default)
  - Bounding box overlays on detected objects
  - Monthly and hourly visit frequency charts
  - Lightbox view with detection details
- **Local Dashboard**: Real-time monitoring at http://192.168.1.252:8080
- **FIFO Storage Management**: Automatically deletes oldest files when approaching 20,000 file limit
- **Secure**: Worker API requires Bearer token authentication; all credentials in `.env`

## Project Structure

```
hummingbird-camera/
├── pi-local/                    # Raspberry Pi local code
│   ├── app/
│   │   ├── config.py           # Configuration management
│   │   ├── capture.py          # Motion detection & capture (picamera2)
│   │   ├── detector.py         # MobileNet-SSD detection via OpenCV DNN
│   │   ├── uploader.py         # Cloudflare R2 upload
│   │   └── notifier.py         # Mailjet email alerts
│   ├── web/
│   │   ├── server.py           # Flask dashboard server
│   │   └── templates/
│   │       └── index.html      # Local dashboard UI
│   ├── main.py                 # Main orchestrator
│   ├── requirements.txt
│   └── .env                    # Configuration (create from .env.example)
├── cloudflare-worker/           # Cloudflare Worker API
│   ├── src/
│   │   └── index.js            # Worker code (upload, list, stats, FIFO)
│   └── wrangler.toml           # Worker config
├── cloudflare-pages/            # Cloudflare Pages frontend
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── deploy.sh                    # Deployment script for Pi
├── .env.example                 # Environment template
└── README.md                    # This file
```

## Prerequisites

### Hardware
- Raspberry Pi 3 Model B (or better) with 32GB+ SD card
- Raspberry Pi Camera Module (NoIR recommended for low-light)
- Power supply (official recommended)
- Internet connection (Ethernet or Wi-Fi)

### Software
- Raspberry Pi OS Bookworm (64-bit recommended)
- SSH access to Raspberry Pi
- Cloudflare account (free tier)
- Mailjet account (free tier)
- Node.js 18+ on your local machine (for Cloudflare deployment)

## Installation

### Step 1: Prepare the Raspberry Pi

SSH into your Raspberry Pi:
```bash
ssh prodigy@192.168.1.252
```

Enable the camera (if not already enabled):
```bash
sudo raspi-config
# Navigate to: Interface Options → Camera → Enable
# Reboot if prompted
```

Verify camera is working:
```bash
libcamera-hello
```

### Step 2: Transfer the Project

**Option A: Transfer from your computer**
```bash
# From your local machine
scp -r hummingbird-camera prodigy@192.168.1.252:~/
```

**Option B: Clone from GitHub**
```bash
cd ~
git clone https://github.com/ps3btc/hummingbird-camera.git
cd hummingbird-camera
```

### Step 3: Configure Environment Variables

```bash
cd ~/hummingbird-camera
cp .env.example pi-local/.env
nano pi-local/.env
```

Edit the following values:
```env
# Cloudflare (get from Cloudflare dashboard after deploying Worker)
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_bearer_token_for_worker_api
CLOUDFLARE_R2_BUCKET=hummingbird-captures
CLOUDFLARE_WORKER_URL=https://hummingbird-camera.your-subdomain.workers.dev

# Mailjet (already configured)
MAILJET_API_KEY=af045d54aa878f2e805763dacb3f8bae
MAILJET_SECRET_KEY=3d69d25f47b407ac6471e2c45e533d41
ALERT_EMAIL_TO=hareesh.nagarajan@gmail.com
ALERT_EMAIL_FROM=alerts@loglinearexplorations.online

# Camera settings
CAMERA_RESOLUTION=640x480
MOTION_THRESHOLD=25
MOTION_MIN_AREA=5000
CAPTURE_COOLDOWN_SEC=5
DETECTION_CONF_THRESHOLD=0.45

# Web server
FLASK_HOST=0.0.0.0
FLASK_PORT=8080
```

### Step 4: Run Deployment Script

```bash
cd ~/hummingbird-camera
chmod +x deploy.sh
./deploy.sh
```

The script will:
- Install system dependencies (Python 3, OpenCV 4.x, picamera2, etc.)
- Set up Python virtual environment with `--system-site-packages`
- Install Python packages (Flask, requests, numpy, etc.)
- Download MobileNet-SSD Caffe model (~23MB)
- Create systemd services for camera and dashboard
- Enable services to start on boot

**Important**: The script pins OpenCV to 4.x (not 5.0) because OpenCV 5.0 removed the Caffe DNN importer.

### Step 5: Deploy Cloudflare Components

#### 5a. Create R2 Bucket

On your local machine (with Node.js installed):
```bash
# Login to Cloudflare
npx wrangler login

# Create R2 bucket
npx wrangler r2 bucket create hummingbird-captures
```

Or via Cloudflare dashboard: R2 Object Storage → Create bucket → `hummingbird-captures`

#### 5b. Deploy Worker

```bash
cd cloudflare-worker

# Set the API token secret (choose a long random string)
npx wrangler secret put API_TOKEN
# When prompted, paste your token (e.g., hb-cam-8f3kq9z2x7v1m4n6)

# Deploy
npx wrangler deploy
```

Note the Worker URL (e.g., `https://hummingbird-camera.flyingokapi.workers.dev`) and update it in:
1. Pi's `pi-local/.env` → `CLOUDFLARE_WORKER_URL`
2. Pi's `pi-local/.env` → `CLOUDFLARE_API_TOKEN` (must match the secret you just set)

#### 5c. Deploy Pages

```bash
cd cloudflare-pages

# Update WORKER_URL in js/app.js with your Worker URL
nano js/app.js
# Change line 7: const WORKER_URL = 'https://hummingbird-camera.flyingokapi.workers.dev';

# Create Pages project (first time only)
npx wrangler pages project create hummingbird-gallery --production-branch main

# Deploy
npx wrangler pages deploy . --project-name hummingbird-gallery
```

Your gallery will be at: `https://hummingbird-gallery.pages.dev`

### Step 6: Start the System

```bash
# Start camera system
sudo systemctl start hummingbird-camera

# Start dashboard
sudo systemctl start hummingbird-dashboard

# Check status
sudo systemctl status hummingbird-camera
sudo systemctl status hummingbird-dashboard

# Watch logs
sudo journalctl -u hummingbird-camera -f
```

You should see:
```
Camera initialized with picamera2
MobileNet-SSD loaded via OpenCV DNN (Caffe)
System initialized successfully
Starting main processing loop...
```

Walk in front of the camera to test. You should see:
```
Detection in ~120ms | birds=False animals=False humans=True | 1 objects
Upload successful: capture_20260827_xxxxxx.jpg
```

## Usage

### Local Dashboard

Access the local dashboard at:
```
http://192.168.1.252:8080
```

Features:
- Real-time system status (RUNNING/STOPPED)
- Live log stream via Server-Sent Events
- Detection statistics (captures, uploads, alerts)
- Last detection/capture timestamps
- R2 file count

### Cloud Gallery

Access your cloud gallery at:
```
https://hummingbird-gallery.pages.dev
```

Features:
- **Summary cards**: Total visits, bird visits, animal visits, human visits
- **Analytics charts**: Monthly visits (last 12 months) + hourly visits (24 hours)
- **Filter buttons**: All / Birds / Animals / Humans
- **Category toggles**: Independently show/hide Birds, Animals, Humans (humans hidden by default)
- **Gallery cards**: Thumbnail, type badge, confidence score, timestamp, bounding box overlay
- **Lightbox**: Full-size view with detection chips and bbox overlays
- **Mobile responsive**: Works on phones, tablets, desktops
- **Keyboard navigation**: Arrow keys in lightbox, Escape to close

### Email Alerts

You'll receive email alerts when:
- A bird is detected
- An animal is detected (excluding humans)

Alerts include:
- Detection timestamp
- List of detected animals with confidence scores
- Attached image

### Viewing Logs

```bash
# Camera system logs
sudo journalctl -u hummingbird-camera -f

# Dashboard logs
sudo journalctl -u hummingbird-dashboard -f

# Application logs
tail -f ~/hummingbird-camera/pi-local/logs/system.log
```

### Managing Services

```bash
# Stop services
sudo systemctl stop hummingbird-camera
sudo systemctl stop hummingbird-dashboard

# Restart services
sudo systemctl restart hummingbird-camera
sudo systemctl restart hummingbird-dashboard

# Disable auto-start
sudo systemctl disable hummingbird-camera
sudo systemctl disable hummingbird-dashboard

# Enable auto-start
sudo systemctl enable hummingbird-camera
sudo systemctl enable hummingbird-dashboard
```

## Configuration Options

Edit `pi-local/.env` to customize:

```env
# Camera settings
CAMERA_RESOLUTION=640x480    # Lower = faster processing (320x240 for max speed)
MOTION_THRESHOLD=25          # Motion sensitivity (lower = more sensitive, range 1-100)
MOTION_MIN_AREA=5000         # Minimum motion area in pixels (lower = more sensitive)
CAPTURE_COOLDOWN_SEC=5       # Seconds between captures

# Detection settings
DETECTION_CONF_THRESHOLD=0.45  # Detection confidence threshold (0.0-1.0)

# Web server
FLASK_HOST=0.0.0.0
FLASK_PORT=8080              # Port 80 requires root; 8080 works for non-root
```

## Troubleshooting

### Camera not detected
```bash
# Check camera connection
vcgencmd get_camera

# Test camera
libcamera-hello

# If "No camera found", check ribbon cable connection
```

### "Device or resource busy" error
```bash
# Something else is using the camera
sudo lsof | grep -i camera
sudo pkill -f picamera

# Or reboot
sudo reboot
```

### "No module named 'picamera'"
```bash
# venv needs --system-site-packages to see system picamera2
source ~/hummingbird-camera/pi-local/venv/bin/activate
python -c "import picamera2; print('OK')"

# If fails, recreate venv:
deactivate
rm -rf ~/hummingbird-camera/pi-local/venv
cd ~/hummingbird-camera/pi-local
python3 -m venv --system-site-packages venv
source venv/bin/activate
pip install -r requirements.txt
```

### "Failed to load detection model"
```bash
# Check model files exist
ls -lh ~/hummingbird-camera/pi-local/app/models/

# Should see: MobileNetSSD_deploy.prototxt (44K) and MobileNetSSD_deploy.caffemodel (23M)

# Test model loading
source ~/hummingbird-camera/pi-local/venv/bin/activate
cd ~/hummingbird-camera/pi-local/app/models/
python -c "import cv2; net = cv2.dnn.readNetFromCaffe('MobileNetSSD_deploy.prototxt', 'MobileNetSSD_deploy.caffemodel'); print('OK')"
```

### OpenCV 5.0 errors ("readNetFromCaffe not found")
```bash
# Must use OpenCV 4.x (5.0 removed Caffe support)
source ~/hummingbird-camera/pi-local/venv/bin/activate
python -c "import cv2; print(cv2.__version__)"

# If shows 5.x, downgrade:
pip install --no-cache-dir --force-reinstall "opencv-python-headless>=4.5.0,<5.0.0"
```

### Low FPS / Slow detection
- Lower `CAMERA_RESOLUTION` to 320x240
- Increase `CAPTURE_COOLDOWN_SEC` to 10
- MobileNet-SSD runs ~120ms on Pi 3; this is normal

### Upload failures
- Check internet connection: `ping google.com`
- Verify Cloudflare credentials in `pi-local/.env`
- Check Worker URL is correct (test with `curl https://your-worker.workers.dev/count`)
- View logs: `sudo journalctl -u hummingbird-camera -n 50`

### Email not sending
- Verify Mailjet credentials in `pi-local/.env`
- Check sender email is verified in Mailjet dashboard
- View logs: `sudo journalctl -u hummingbird-camera | grep -i mailjet`

### Gallery shows "Could not reach the Worker API"
- Check `WORKER_URL` in `cloudflare-pages/js/app.js` matches your deployed Worker
- Test Worker: `curl https://your-worker.workers.dev/stats`
- Redeploy Pages: `npx wrangler pages deploy . --project-name hummingbird-gallery`

### High memory usage
The system is configured with memory limits in systemd:
```ini
MemoryMax=800M
CPUQuota=80%
```

Adjust in `/etc/systemd/system/hummingbird-camera.service` if needed.

## Performance Expectations

On Raspberry Pi 3 Model B:
- Motion detection: ~10-15 FPS
- MobileNet-SSD inference: ~120ms per frame
- Total cycle: ~1-2 seconds per detection
- Memory usage: ~400-600MB
- CPU usage: ~30-50% during detection

## Security Notes

- All API credentials stored in `.env` file (not in code)
- `.env` file is in `.gitignore` and not committed to Git
- Worker API requires Bearer token authentication (stored as Cloudflare secret)
- GET endpoints (`/list`, `/stats`, `/count`, `/image/:key`) are public for gallery access
- POST/DELETE endpoints (`/upload`, `/oldest`) require the API token
- Consider adding rate limiting to Worker if exposed publicly

## Cost Breakdown (Free Tier)

- **Cloudflare R2**: 10GB storage, 10M reads/month, 1M writes/month
- **Cloudflare Pages**: Unlimited bandwidth, 500 builds/month
- **Cloudflare Workers**: 100K requests/day
- **Mailjet**: 200 emails/day (6000/month)
- **File Limit**: 20,000 files per R2 bucket (managed by FIFO deletion)

## Development

### Local testing (non-Pi)
```bash
cd pi-local
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Run dashboard only (no camera)
python web/server.py
```

### Updating the Worker
```bash
cd cloudflare-worker
# Edit src/index.js
npx wrangler deploy
```

### Updating the Pages site
```bash
cd cloudflare-pages
# Edit files
# Update WORKER_URL in js/app.js if needed
npx wrangler pages deploy . --project-name hummingbird-gallery
```

## Future Enhancements

- [ ] Add night vision mode for NoIR camera
- [ ] Implement bird species classification
- [ ] Add time-lapse video generation
- [ ] Push notifications via mobile app
- [ ] Integrate weather data overlay
- [ ] Add object tracking across frames
- [ ] Implement confidence-based filtering
- [ ] Add manual capture via dashboard (re-enable with camera locking)
- [ ] Support multiple cameras
- [ ] Add video recording mode

## License

MIT License - Feel free to modify and use for your own projects.

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review logs: `sudo journalctl -u hummingbird-camera -f`
3. Verify all credentials in `pi-local/.env`
4. Check Cloudflare dashboard for R2/Worker status
5. Open an issue on GitHub: https://github.com/ps3btc/hummingbird-camera/issues

## Credits

Built with:
- MobileNet-SSD via OpenCV DNN
- Cloudflare Workers/Pages/R2
- Mailjet Email API
- Flask & OpenCV
- picamera2
- Raspberry Pi Foundation
