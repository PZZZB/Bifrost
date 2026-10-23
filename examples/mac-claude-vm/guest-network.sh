#!/bin/bash
set -euo pipefail
mode=${1:-lock}
case "$mode" in
  lock)
    proxy_uid=$(id -u mihomo)
    # Include replacement in one transaction, so reload never opens the firewall.
    existing=""
    nft list table inet claude_lock >/dev/null 2>&1 && existing="delete table inet claude_lock"
    nft -f - <<EOF
$existing
table inet claude_lock {
  chain input {
    type filter hook input priority -50; policy drop;
    iifname "lo" accept
    meta nfproto ipv6 drop
    ct state established,related accept
    iifname "vmhost0" ip saddr 192.168.160.1 tcp dport 3435 ct state new accept
    iifname "claude0" accept
  }
  chain output {
    type filter hook output priority -50; policy drop;
    oifname "lo" accept
    meta nfproto ipv6 reject
    oifname "vmhost0" ip daddr 192.168.160.1 tcp sport 3435 ct state established accept
    oifname "vmhost0" ip daddr 192.168.160.1 tcp dport 17890 meta skuid $proxy_uid accept
    oifname "claude0" ip protocol tcp accept
    oifname "claude0" udp dport 53 accept
    reject
  }
  chain forward {
    type filter hook forward priority -50; policy drop;
  }
}
EOF
    ;;
  routes)
    for n in {1..50}; do
      ip link show claude0 >/dev/null 2>&1 && break
      sleep 0.1
    done
    ip link set claude0 up
    ip route replace 0.0.0.0/1 dev claude0
    ip route replace 128.0.0.0/1 dev claude0
    ;;
  *) echo "Unknown operation" >&2; exit 2 ;;
esac
