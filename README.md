# Hummingbird Camera System

An AI-powered, motion-triggered camera system for capturing hummingbirds and wildlife on a Raspberry Pi 3 Model B. Features local object detection, cloud storage, mobile-friendly gallery, and automated email alerts.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Raspberry Pi 3 Model B                    │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │   Camera     │→ │   Motion     │→ │   AI Detection   │  │
│  │   (NoIR)     │  │   Detection  │  │   (YOLOv8n)      │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                               │              │
│                          ┌────────────────────┼──────────┐  │
│                          │                    │          │  │
│                          ▼                    ▼          ▼  │
│                   ┌─────────────┐    ┌──────────┐  ┌─────┐ │
│                   │  Upload to  │    │  Email   │  │Local│ │
│                   │  Cloudflare │    │  Alert   │  │Dashboard│
│                   │  R2         │    │(Mailjet) │  │(Flask)│ │
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
- **AI Object Detection**: Uses YOLOv8-nano to detect birds, animals, and humans
- **Smart Routing**:
  - Any object detected → Upload to Cloudflare R2
  - Animal/bird detected (no humans) → Send email alert via Mailjet
- **Cloud Gallery**: Mobile-friendly web app to view all captures
- **Local Dashboard**: Real-time monitoring at http://192.168.1.252
- **FIFO Storage Management**: Automatically deletes oldest files when approaching 20,000 file limit
- **Secure**: All credentials stored in `.env` file, never hardcoded

## Project Structure

```
hummingbird-camera/
├── pi-local/                    # Raspberry Pi local code
│   ├── app/
│   │   ├── config.py           # Configuration management
│   │   ├── capture.py          # Motion detection & capture
│   │   ├── detector.py         # YOLO object detection
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
│   │   └── index.js            # Worker code
│   └── wrangler.toml           # Worker config
├── cloudflare-pages/            # Cloudflare Pages frontend
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── deploy.sh                    # Deployment script
└── .env.example                 # Environment template
```

## Prerequisites

### Hardware
- Raspberry Pi 3 Model B (or better)
- Raspberry Pi NoIR Camera Module
- MicroSD card (8GB+)
- Power supply
- Internet connection

### Software
- Raspberry Pi OS (Bookworm or later recommended)
- SSH access to Raspberry Pi
- Cloudflare account (free tier)
- Mailjet account (free tier)
- Node.js (for Cloudflare deployment)

## Installation

### 1. Prepare the Raspberry Pi

SSH into your Raspberry Pi:
```bash
ssh prodigy@192.168.1.252
```

Enable the camera:
```bash
sudo raspi-config
# Navigate to: Interface Options → Camera → Enable
# Reboot if prompted
```

### 2. Clone/Transfer the Project

Option A: Transfer from your computer
```bash
# From your local machine
scp -r hummingbird-camera prodigy@192.168.1.252:~/
```

Option B: Clone from Git (if you've pushed to a repository)
```bash
cd ~
git clone <your-repo-url> hummingbird-camera
```

### 3. Configure Environment Variables

```bash
cd ~/hummingbird-camera
cp .env.example pi-local/.env
nano pi-local/.env
```

Edit the following values:
```env
# Cloudflare (get from Cloudflare dashboard)
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_api_token
CLOUDFLARE_R2_BUCKET=hummingbird-captures
CLOUDFLARE_WORKER_URL=https://hummingbird-camera.your-subdomain.workers.dev

# Mailjet (already configured)
MAILJET_API_KEY=af045d54aa878f2e805763dacb3f8bae
MAILJET_SECRET_KEY=3d69d25f47b407ac6471e2c45e533d41
ALERT_EMAIL_TO=hareesh.nagarajan@gmail.com
ALERT_EMAIL_FROM=alerts@loglinearexplorations.online
```

### 4. Run Deployment Script

```bash
cd ~/hummingbird-camera
chmod +x deploy.sh
./deploy.sh
```

The script will:
- Install system dependencies
- Set up Python virtual environment
- Install Python packages
- Create systemd services
- Enable services to start on boot

### 5. Deploy Cloudflare Components

#### Create R2 Bucket
```bash
# On your local machine with wrangler installed
npx wrangler r2 bucket create hummingbird-captures
```

#### Deploy Worker
```bash
cd cloudflare-worker
npm install
npx wrangler deploy
```

Note the worker URL (e.g., `https://hummingbird-camera.your-subdomain.workers.dev`) and update it in your `.env` file.

#### Deploy Pages
```bash
cd cloudflare-pages
# Update WORKER_URL in js/app.js with your worker URL
nano js/app.js

# Deploy
npx wrangler pages deploy . --project-name=hummingbird-camera
```

### 6. Start the System

```bash
# Start camera system
sudo systemctl start hummingbird-camera

# Start dashboard
sudo systemctl start hummingbird-dashboard

# Check status
sudo systemctl status hummingbird-camera
sudo systemctl status hummingbird-dashboard
```

## Usage

### Local Dashboard

Access the local dashboard at:
```
http://192.168.1.252
```

Features:
- Real-time system status
- Live log stream
- Recent captures gallery
- System statistics

### Cloud Gallery

Access your cloud gallery at the Pages URL (e.g.):
```
https://hummingbird-camera.pages.dev
```

Features:
- Mobile-responsive design
- Filter by birds/animals/humans
- Timestamp display on all images
- Lightbox view with detection details

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
journalctl -u hummingbird-camera -f

# Dashboard logs
journalctl -u hummingbird-dashboard -f

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
```

## Configuration Options

Edit `pi-local/.env` to customize:

```env
# Camera settings
CAMERA_RESOLUTION=640x480    # Lower = faster processing
MOTION_THRESHOLD=25          # Motion sensitivity (lower = more sensitive)
MOTION_MIN_AREA=5000         # Minimum motion area in pixels
CAPTURE_COOLDOWN_SEC=5       # Seconds between captures

# Detection settings
DETECTION_CONF_THRESHOLD=0.45  # Detection confidence threshold

# Web server
FLASK_HOST=0.0.0.0
FLASK_PORT=80
```

## Troubleshooting

### Camera not detected
```bash
# Check camera connection
vcgencmd get_camera

# Test camera
libcamera-hello
```

### Low FPS / Slow detection
- Lower `CAMERA_RESOLUTION` to 320x240
- Increase `CAPTURE_COOLDOWN_SEC`
- Consider using TFLite model instead of YOLOv8n

### Upload failures
- Check internet connection
- Verify Cloudflare credentials in `.env`
- Check worker URL is correct
- View logs: `journalctl -u hummingbird-camera -n 50`

### Email not sending
- Verify Mailjet credentials
- Check sender email is verified in Mailjet
- View logs for error messages

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
- YOLOv8n inference: ~1-2 seconds per frame
- Total cycle: ~2-3 seconds per detection
- Memory usage: ~500-700MB

## Security Notes

- All API credentials stored in `.env` file (not in code)
- `.env` file should not be committed to Git
- Worker API requires Bearer token authentication
- Consider adding rate limiting to worker if exposed publicly

## Cost Breakdown (Free Tier)

- **Cloudflare R2**: 10GB storage, 10M reads/month, 1M writes/month
- **Cloudflare Pages**: Unlimited bandwidth, 500 builds/month
- **Cloudflare Workers**: 100K requests/day
- **Mailjet**: 200 emails/day (6000/month)
- **File Limit**: 20,000 files per R2 bucket (managed by FIFO)

## Future Enhancements

- [ ] Add night vision mode for NoIR camera
- [ ] Implement bird species classification
- [ ] Add time-lapse video generation
- [ ] Push notifications via mobile app
- [ ] Integrate weather data overlay
- [ ] Add object tracking across frames
- [ ] Implement confidence-based filtering
- [ ] Add manual capture via dashboard

## License

MIT License - Feel free to modify and use for your own projects.

## Support

For issues or questions:
1. Check the troubleshooting section
2. Review logs: `journalctl -u hummingbird-camera -f`
3. Verify all credentials in `.env`
4. Check Cloudflare dashboard for R2/Worker status

## Credits

Built with:
- YOLOv8 by Ultralytics
- Cloudflare Workers/Pages/R2
- Mailjet Email API
- Flask & OpenCV
- Raspberry Pi Foundation
