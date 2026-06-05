#!/usr/bin/env bash
# Sirve el spike en 0.0.0.0:PORT para acceso por localhost (Mac) y por IP de LAN (tablet Android).
set -euo pipefail

PORT="${1:-8099}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detecta IP de LAN (en0 wifi, luego en1)
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '<IP-LAN>')"

echo "──────────────────────────────────────────────"
echo "  Plick · Spike impresión web BT"
echo "──────────────────────────────────────────────"
echo "  Mac (contexto seguro automático):"
echo "    http://localhost:${PORT}"
echo ""
echo "  Tablet Android (misma red WiFi):"
echo "    http://${LAN_IP}:${PORT}"
echo ""
echo "  ⚠ Web Bluetooth por IP de LAN NO es contexto seguro por defecto."
echo "    En el Chrome de la tablet, abre:"
echo "      chrome://flags/#unsafely-treat-insecure-origin-as-secure"
echo "    Agrega:  http://${LAN_IP}:${PORT}"
echo "    Pon 'Enabled' y reinicia Chrome. Luego abre la URL de arriba."
echo "──────────────────────────────────────────────"
echo "  Ctrl+C para detener."
echo ""

cd "$DIR"
exec python3 -m http.server "$PORT" --bind 0.0.0.0
