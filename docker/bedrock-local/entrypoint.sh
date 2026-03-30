#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="/data"
TEMPLATE_DIR="/opt/bedrock-template"
ADDON_DIR="/opt/addons/behavior_packs/network_core"
PACK_DIR="$DATA_DIR/behavior_packs/network_core"
PACK_UUID="90fb3299-d58f-4678-b654-3e6c8fd1ff73"
PACK_VERSION="[1, 0, 0]"
SCRIPT_MODULE_UUID="6a70bb42-c22d-4355-9ee7-1edbcb53efdb"
WORLD_TEMPLATE_DIR="${WORLD_TEMPLATE_DIR:-}"

mkdir -p "$DATA_DIR"
cp -an "$TEMPLATE_DIR"/. "$DATA_DIR"/

chmod +x "$DATA_DIR/bedrock_server"

write_property() {
  local key="$1"
  local value="$2"
  local file="$DATA_DIR/server.properties"

  touch "$file"

  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

install_network_core() {
  if [ ! -d "$ADDON_DIR" ]; then
    return
  fi

  mkdir -p "$PACK_DIR"
  cp -a "$ADDON_DIR"/. "$PACK_DIR"/
}

seed_world_from_template() {
  local level_name="${LEVEL_NAME:-Bedrock level}"
  local world_dir="$DATA_DIR/worlds/$level_name"

  if [ -z "$WORLD_TEMPLATE_DIR" ] || [ ! -d "$WORLD_TEMPLATE_DIR" ]; then
    return
  fi

  mkdir -p "$world_dir"

  if find "$world_dir" -mindepth 1 -print -quit | grep -q .; then
    return
  fi

  cp -a "$WORLD_TEMPLATE_DIR"/. "$world_dir"/
}

ensure_world_display_name() {
  local level_name="${LEVEL_NAME:-Bedrock level}"
  local world_dir="$DATA_DIR/worlds/$level_name"
  local world_display_name="${WORLD_DISPLAY_NAME:-}"

  if [ -z "$world_display_name" ]; then
    return
  fi

  mkdir -p "$world_dir"
  printf '%s\n' "$world_display_name" > "$world_dir/levelname.txt"
}

configure_script_permissions() {
  local config_dir="$DATA_DIR/config/$SCRIPT_MODULE_UUID"

  mkdir -p "$config_dir"

  cat > "$config_dir/permissions.json" <<'JSON'
{
  "allowed_modules": [
    "@minecraft/server",
    "@minecraft/server-admin",
    "@minecraft/server-ui",
    "@minecraft/server-net"
  ]
}
JSON

  cat > "$config_dir/variables.json" <<JSON
{
  "networkBaseUrl": "${NETWORK_BASE_URL:-http://api:8080}",
  "serverSlug": "${SERVER_SLUG:-${LEVEL_NAME:-capital}}",
  "transferHost": "${TRANSFER_HOST:-}",
  "adminCreativeGamertags": "${ADMIN_CREATIVE_GAMERTAGS:-}",
  "adminOperatorXuIds": "${ADMIN_OPERATOR_XUIDS:-}",
  "allowExtraDimensions": "${ALLOW_EXTRA_DIMENSIONS:-false}",
  "capitalPort": ${CAPITAL_PUBLIC_PORT:-19132},
  "arenasPort": ${ARENAS_PUBLIC_PORT:-19133},
  "firePort": ${FIRE_PUBLIC_PORT:-19134},
  "waterPort": ${WATER_PUBLIC_PORT:-19135},
  "earthPort": ${EARTH_PUBLIC_PORT:-19136},
  "airPort": ${AIR_PUBLIC_PORT:-19137},
  "explorationPort": ${EXPLORATION_PUBLIC_PORT:-19138},
  "heartbeatIntervalTicks": "${NETWORK_HEARTBEAT_INTERVAL_TICKS:-200}",
  "autosaveIntervalTicks": "${NETWORK_AUTOSAVE_INTERVAL_TICKS:-1200}"
}
JSON
}

configure_operator_permissions() {
  local permissions_file="$DATA_DIR/permissions.json"
  local operator_xuids="${ADMIN_OPERATOR_XUIDS:-}"

  if [ -z "$operator_xuids" ]; then
    return
  fi

  python3 - "$permissions_file" "$operator_xuids" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
operator_xuids = [
    entry.strip()
    for entry in sys.argv[2].split(",")
    if entry.strip()
]

data = []
if path.exists():
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(loaded, list):
            data = [item for item in loaded if isinstance(item, dict)]
    except Exception:
        data = []

entries_by_xuid = {}
for item in data:
    xuid = str(item.get("xuid", "")).strip()
    if xuid:
        entries_by_xuid[xuid] = {
            "permission": str(item.get("permission", "member")).strip() or "member",
            "xuid": xuid,
        }

for xuid in operator_xuids:
    entries_by_xuid[xuid] = {
        "permission": "operator",
        "xuid": xuid,
    }

ordered = sorted(entries_by_xuid.values(), key=lambda item: item["xuid"])
path.write_text(
    json.dumps(ordered, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
PY
}

ensure_world_pack_reference() {
  local level_name="${LEVEL_NAME:-Bedrock level}"
  local world_dir="$DATA_DIR/worlds/$level_name"
  local world_packs_file="$world_dir/world_behavior_packs.json"
  local experiments_file="$world_dir/experiments.json"

  mkdir -p "$world_dir"

  if [ ! -f "$world_packs_file" ]; then
    cat > "$world_packs_file" <<JSON
[
  {
    "pack_id": "$PACK_UUID",
    "version": $PACK_VERSION
  }
]
JSON
  else
    python3 - "$world_packs_file" "$PACK_UUID" "$PACK_VERSION" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
pack_id = sys.argv[2]
version = json.loads(sys.argv[3])

data = []
if path.exists():
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(loaded, list):
            data = loaded
    except Exception:
        data = []

if not any(isinstance(item, dict) and item.get("pack_id") == pack_id for item in data):
    data.append({"pack_id": pack_id, "version": version})

path.write_text(
    json.dumps(data, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
PY
  fi

  cat > "$experiments_file" <<'JSON'
{
  "experiments": {
    "data_driven_items": false,
    "upcoming_creator_features": true,
    "beta_apis": true,
    "scripting": true
  }
}
JSON
}

patch_world_level_dat() {
  local level_name="${LEVEL_NAME:-Bedrock level}"
  local level_dat="$DATA_DIR/worlds/$level_name/level.dat"
  local level_dat_old="$DATA_DIR/worlds/$level_name/level.dat_old"
  local world_display_name="${WORLD_DISPLAY_NAME:-${SERVER_NAME:-$level_name}}"
  local world_difficulty="${DIFFICULTY:-easy}"

  if [ -f "$level_dat" ]; then
    if [ ! -f "$level_dat_old" ]; then
      cp "$level_dat" "$level_dat_old"
    fi

    if ! python3 /usr/local/bin/patch-level-dat.py \
      --level-name "$world_display_name" \
      --difficulty "$world_difficulty" \
      --allow-cheats "${ALLOW_CHEATS:-true}" \
      "$level_dat"; then
      printf 'Warning: unable to patch %s for Beta APIs.\n' "$level_dat" >&2
    fi
  fi
}

write_property "server-name" "${SERVER_NAME:-Dedicated Server}"
write_property "level-name" "${LEVEL_NAME:-Bedrock level}"
write_property "server-port" "${SERVER_PORT:-19132}"
write_property "server-portv6" "${SERVER_PORT_V6:-19133}"
write_property "gamemode" "${GAMEMODE:-survival}"
write_property "difficulty" "${DIFFICULTY:-easy}"
write_property "allow-cheats" "${ALLOW_CHEATS:-true}"
write_property "content-log-file-enabled" "true"
write_property "content-log-console-output-enabled" "true"
write_property "content-log-level" "verbose"

install_network_core
seed_world_from_template
ensure_world_display_name
configure_script_permissions
configure_operator_permissions
ensure_world_pack_reference
patch_world_level_dat

cd "$DATA_DIR"
export LD_LIBRARY_PATH="$DATA_DIR"

exec ./bedrock_server
