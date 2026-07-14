#!/bin/sh
# Kiểm tra / tải / áp dụng firmware H2T mới từ portal.
# Chạy bởi cron hoặc thủ công: h2t-check-update
set -e

H2T_DIR="/etc/h2t-wifi"
DOMAIN=$(cat "$H2T_DIR/portal_domain" 2>/dev/null || echo "")
if [ -z "$DOMAIN" ]; then
  # Fallback: đọc fasremotefqdn từ opennds
  DOMAIN=$(uci -q get opennds.@opennds[0].fasremotefqdn 2>/dev/null || true)
fi
[ -z "$DOMAIN" ] && { echo "Chưa biết portal domain"; exit 0; }

CUR=$(cat "$H2T_DIR/VERSION" 2>/dev/null || echo "0.0.0")
TMPDIR=$(mktemp -d 2>/dev/null || echo /tmp/h2t-fw.$$)
cd "$TMPDIR" || exit 1

# latest.env dạng shell: VERSION=... SHA256=... FILENAME=...
if command -v uclient-fetch >/dev/null 2>&1; then
  uclient-fetch -q -O latest.env "https://$DOMAIN/firmware/latest.env" || true
else
  wget -qO latest.env "https://$DOMAIN/firmware/latest.env" || true
fi

[ -f latest.env ] || { echo "Không tải được latest.env"; rm -rf "$TMPDIR"; exit 0; }

# shellcheck disable=SC1091
. ./latest.env

[ -n "$VERSION" ] || { echo "Manifest lỗi"; rm -rf "$TMPDIR"; exit 0; }

# So sánh version đơn giản (string khác là cập nhật — admin kiểm soát semver)
if [ "$VERSION" = "$CUR" ]; then
  echo "Đã ở phiên bản mới nhất: $CUR"
  rm -rf "$TMPDIR"
  exit 0
fi

echo "Có bản mới: $CUR -> $VERSION"
FILE="${FILENAME:-h2t-router-$VERSION.tar.gz}"
URL="https://$DOMAIN/firmware/download/$FILE"

if command -v uclient-fetch >/dev/null 2>&1; then
  uclient-fetch -q -O "$FILE" "$URL" || { echo "Tải gói thất bại"; rm -rf "$TMPDIR"; exit 1; }
else
  wget -qO "$FILE" "$URL" || { echo "Tải gói thất bại"; rm -rf "$TMPDIR"; exit 1; }
fi

# Verify sha256 nếu có
if [ -n "$SHA256" ] && command -v sha256sum >/dev/null 2>&1; then
  echo "$SHA256  $FILE" | sha256sum -c - || { echo "SHA256 không khớp"; rm -rf "$TMPDIR"; exit 1; }
fi

mkdir -p extract
tar -xzf "$FILE" -C extract
cd extract
chmod +x update.sh
H2T_FW_VERSION="$VERSION" ./update.sh

rm -rf "$TMPDIR"
echo "Update xong $VERSION"
