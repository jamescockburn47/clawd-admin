#!/bin/bash
# Deploy clawd-dashboard to Pi 5
# Usage: ./deploy.sh [build|restart|full]

PI="pi@192.168.1.211"
KEY="C:/Users/James/.ssh/id_ed25519"
REMOTE_DIR="/home/pi/clawd-dashboard"
LOCAL_DIR="$(dirname "$0")"

ssh_cmd() { ssh -i "$KEY" "$PI" "$1"; }
scp_cmd() { scp -i "$KEY" "$@"; }

deploy_files() {
    echo "==> Deploying source files..."
    scp_cmd "$LOCAL_DIR/Cargo.toml" "$PI:$REMOTE_DIR/Cargo.toml"
    scp_cmd "$LOCAL_DIR/src/"*.rs "$PI:$REMOTE_DIR/src/"
    scp_cmd "$LOCAL_DIR/src/widgets/"*.rs "$PI:$REMOTE_DIR/src/widgets/"
    scp_cmd "$LOCAL_DIR/src/shaders/"*.wgsl "$PI:$REMOTE_DIR/src/shaders/"
    echo "    Done."
}

build() {
    echo "==> Building on Pi (release)..."
    ssh_cmd "source ~/.cargo/env && cd $REMOTE_DIR && cargo build --release 2>&1"
}

restart() {
    echo "==> Restarting dashboard..."
    ssh_cmd "pkill clawd-dashboard 2>/dev/null; sleep 1; export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0; nohup $REMOTE_DIR/target/release/clawd-dashboard > /tmp/clawd-dashboard.log 2>&1 &"
    sleep 3
    ssh_cmd "pgrep -a clawd-dashboard && echo 'Dashboard running' || echo 'FAILED to start'"
}

case "${1:-full}" in
    build)
        deploy_files
        build
        ;;
    restart)
        restart
        ;;
    full)
        deploy_files
        build
        echo ""
        restart
        ;;
    *)
        echo "Usage: $0 [build|restart|full]"
        exit 1
        ;;
esac
