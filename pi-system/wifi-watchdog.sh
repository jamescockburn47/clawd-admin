#!/bin/bash
# wifi-watchdog.sh — Ping router, bounce WiFi if unreachable
# Deployed to /usr/local/bin/ on Pi, triggered by wifi-watchdog.timer every 5 min

ROUTER="192.168.1.254"
IFACE="wlan0"
LOG_TAG="wifi-watchdog"

# Quick ping — 2 attempts, 2s timeout each
if ping -c 2 -W 2 "$ROUTER" > /dev/null 2>&1; then
    exit 0
fi

# Router unreachable — log and bounce
logger -t "$LOG_TAG" "Router $ROUTER unreachable on $IFACE — bouncing WiFi"

nmcli device disconnect "$IFACE" 2>/dev/null
sleep 3
nmcli device connect "$IFACE" 2>/dev/null
sleep 10

# Verify recovery
if ping -c 2 -W 3 "$ROUTER" > /dev/null 2>&1; then
    logger -t "$LOG_TAG" "WiFi recovered after bounce"
else
    # Hard reset — reload kernel module
    logger -t "$LOG_TAG" "Bounce failed — reloading brcmfmac driver"
    rmmod brcmfmac_wcc 2>/dev/null
    rmmod brcmfmac 2>/dev/null
    sleep 3
    modprobe brcmfmac
    sleep 15
    nmcli device connect "$IFACE" 2>/dev/null
    sleep 10
    if ping -c 2 -W 3 "$ROUTER" > /dev/null 2>&1; then
        logger -t "$LOG_TAG" "WiFi recovered after driver reload"
    else
        logger -t "$LOG_TAG" "WiFi STILL unreachable after driver reload"
    fi
fi
