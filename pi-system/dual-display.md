# Pi Dual Display Setup

## Hardware
- HDMI-1 (micro-HDMI closest to USB-C): 10.1" touchscreen, 1024x600
- HDMI-2 (micro-HDMI furthest from USB-C): wall monitor, 1920x1080

## Prerequisites
1. clawd-console running on Pi at port 3100 (systemd service needed)
2. clawdbot running at port 3000 (existing service)
3. Both HDMI displays connected and recognised by Pi OS

## Display Configuration
Edit `/boot/firmware/config.txt` if screens aren't detected:
```
# Dual HDMI output
hdmi_group:0=2
hdmi_mode:0=87
hdmi_cvt:0=1024 600 60
hdmi_group:1=1
hdmi_mode:1=16
```

## Install Services
```bash
sudo cp mission-control.service /etc/systemd/system/
sudo cp calendar-display.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable mission-control.service
sudo systemctl enable calendar-display.service
```

## Start
```bash
sudo systemctl start mission-control
sudo systemctl start calendar-display
```

## Console Service (if not already running)
The console needs to be running on the Pi. Create a service or run:
```bash
cd ~/clawdbot/clawd-console && npm run build && npm start -- -p 3100
```

## Troubleshooting
- If screens show on wrong monitor: swap `--window-position` values
- If Chromium crashes: check `/tmp/chromium-mission-control/` and `/tmp/chromium-calendar/` for crash logs
- Each Chromium instance uses a separate `--user-data-dir` to avoid profile lock conflicts
- The `ExecStartPre=/bin/sleep` gives clawdbot and the console time to start first
