# Quick Start Guide

## Overview
This guide will get your Hummingbird Camera System running in under 30 minutes.

## Prerequisites Checklist
- [ ] Raspberry Pi 3 Model B with power supply
- [ ] Raspberry Pi NoIR Camera module
- [ ] MicroSD card with Raspberry Pi OS installed
- [ ] SSH access to the Pi (username: prodigy, IP: 192.168.1.252)
- [ ] Cloudflare account (free)
- [ ] Mailjet account (free)
- [ ] Node.js installed on your local machine

## Step 1: Prepare Raspberry Pi (5 min)

```bash
# SSH into your Pi
ssh prodigy@192.168.1.252

# Enable camera
sudo raspi-config
# Navigate to: Interface Options → Camera → Enable
# Reboot if prompted

# Verify camera works
libcamera-hello --timeout 5000
```

## Step 2: Transfer Project to Pi (2 min)

From your local machine:
```bash
cd hummingbird-camera
scp -r . prodigy@192.168.1.252:~/hummingbird-camera
```

## Step 3: Configure Credentials (3 min)

```bash
# On the Pi
cd ~/hummingbird-camera
cp .env.example pi-local/.env
nano pi-local/.env
```

**Required changes:**
1. Get Cloudflare Account ID from: https://dash.cloudflare.com/
2. Create API Token with R2 edit permissions
3. Create R2 bucket named `hummingbird-captures`
4. Update the worker URL after deployment (next step)

## Step 4: Deploy Cloudflare Components (10 min)

On your local machine:

```bash
# Install wrangler if not already installed
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Create R2 bucket
wrangler r2 bucket create hummingbird-captures

# Deploy Worker
cd cloudflare-worker
npm install
wrangler deploy
# Note the URL shown (e.g., https://hummingbird-camera.your-subdomain.workers.dev)

# Update the URL in pi-local/.env on your Pi!

# Deploy Pages
cd ../cloudflare-pages
# Edit js/app.js and update WORKER_URL with your worker URL
nano js/app.js
wrangler pages deploy . --project-name=hummingbird-camera
```

## Step 5: Deploy on Raspberry Pi (5 min)

Back on the Pi:
```bash
cd ~/hummingbird-camera

# Make deploy script executable
chmod +x deploy.sh

# Run deployment
./deploy.sh
```

The script will:
- Install all dependencies (~3-5 minutes)
- Set up Python virtual environment
- Create systemd services
- Enable auto-start on boot

## Step 6: Start the System (1 min)

```bash
# Start services
sudo systemctl start hummingbird-camera
sudo systemctl start hummingbird-dashboard

# Verify they're running
sudo systemctl status hummingbird-camera
sudo systemctl status hummingbird-dashboard
```

## Step 7: Test the System (2 min)

1. **Local Dashboard**: Open http://192.168.1.252 in your browser
   - You should see the dashboard with system status
   
2. **Cloud Gallery**: Open your Pages URL (shown after deployment)
   - Should display empty gallery initially
   
3. **Trigger Detection**: Move in front of the camera
   - Check dashboard logs for motion detection
   - Wait for upload to cloud gallery
   - If animal/bird detected (no human), check email

## Verification Checklist

- [ ] Local dashboard accessible at http://192.168.1.252
- [ ] Cloud gallery loads without errors
- [ ] Camera captures images when motion detected
- [ ] Images appear in cloud gallery after upload
- [ ] Email alerts received for animal/bird detections

## Common Issues

### Camera not detected
```bash
# Check camera connection
vcgencmd get_camera
# Should show: supported=1 detected=1
```

### Import errors
```bash
# Activate venv and reinstall
cd ~/hummingbird-camera/pi-local
source venv/bin/activate
pip install -r requirements.txt
```

### Upload failures
- Verify Cloudflare credentials in `.env`
- Check worker URL is correct
- Test worker: `curl https://your-worker.workers.dev/count`

### Email not sending
- Verify Mailjet credentials
- Check sender email is verified in Mailjet dashboard
- View logs: `journalctl -u hummingbird-camera -n 20`

## Next Steps

1. **Position the camera** near a bird feeder or flowering plants
2. **Adjust sensitivity** in `.env` if needed:
   - `MOTION_THRESHOLD` (lower = more sensitive)
   - `DETECTION_CONF_THRESHOLD` (lower = more detections)
3. **Monitor performance** via local dashboard
4. **Customize** detection classes in `detector.py` if needed

## Useful Commands

```bash
# View live logs
journalctl -u hummingbird-camera -f

# Restart services
sudo systemctl restart hummingbird-camera
sudo systemctl restart hummingbird-dashboard

# Stop services
sudo systemctl stop hummingbird-camera
sudo systemctl stop hummingbird-dashboard

# View recent captures
ls -lh ~/hummingbird-camera/pi-local/captures/

# Check disk usage
df -h
du -sh ~/hummingbird-camera/pi-local/captures/
```

## Support

For detailed documentation, see [README.md](README.md)

---

**You're all set!** The system will now automatically capture, detect, upload, and alert you when hummingbirds or other wildlife visit your camera.
