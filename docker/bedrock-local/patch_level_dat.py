from __future__ import annotations

import struct
import sys
from pathlib import Path


OLD_EXPERIMENTS_BLOCK = (
    b"\x01\x15\x00experiments_ever_used\x00"
    b"\x01\x1e\x00saved_with_toggled_experiments\x00"
    b"\x00"
)

NEW_EXPERIMENTS_BLOCK = (
    b"\x01\x15\x00experiments_ever_used\x01"
    b"\x01\x08\x00gametest\x01"
    b"\x01\x1e\x00saved_with_toggled_experiments\x01"
    b"\x00"
)
LEVEL_NAME_TAG = b"\x08\t\x00LevelName"
DIFFICULTY_TAG = b"\x03\n\x00Difficulty"
CHEATS_ENABLED_TAG = b"\x01\r\x00cheatsEnabled"
COMMANDS_ENABLED_TAG = b"\x01\x0f\x00commandsEnabled"
DIFFICULTY_VALUES = {
    "peaceful": 0,
    "easy": 1,
    "normal": 2,
    "hard": 3,
}


def patch_level_name(payload: bytes, level_name: str | None) -> tuple[bytes, int]:
    if not level_name:
        return payload, 0

    level_name_bytes = level_name.encode("utf-8")
    tag_index = payload.find(LEVEL_NAME_TAG)
    if tag_index == -1:
        raise ValueError("level.dat does not contain the expected LevelName tag")

    value_len_offset = tag_index + len(LEVEL_NAME_TAG)
    current_len = struct.unpack_from("<H", payload, value_len_offset)[0]
    value_offset = value_len_offset + 2
    current_name = payload[value_offset:value_offset + current_len]

    if current_name == level_name_bytes:
        return payload, 0

    patched_payload = (
        payload[:value_len_offset]
        + struct.pack("<H", len(level_name_bytes))
        + level_name_bytes
        + payload[value_offset + current_len:]
    )
    return patched_payload, 1


def patch_difficulty(payload: bytes, difficulty: str | None) -> tuple[bytes, int]:
    if not difficulty:
        return payload, 0

    normalized = difficulty.strip().lower()
    if normalized not in DIFFICULTY_VALUES:
        raise ValueError(f"unsupported difficulty: {difficulty}")

    difficulty_value = DIFFICULTY_VALUES[normalized]
    tag_index = payload.find(DIFFICULTY_TAG)
    if tag_index == -1:
        raise ValueError("level.dat does not contain the expected Difficulty tag")

    value_offset = tag_index + len(DIFFICULTY_TAG)
    current_value = struct.unpack_from("<i", payload, value_offset)[0]
    if current_value == difficulty_value:
        return payload, 0

    patched_payload = (
        payload[:value_offset]
        + struct.pack("<i", difficulty_value)
        + payload[value_offset + 4:]
    )
    return patched_payload, 1


def parse_boolean_flag(value: str | None) -> int | None:
    if value is None:
        return None

    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return 1
    if normalized in {"0", "false", "no", "off"}:
        return 0

    raise ValueError(f"unsupported boolean flag: {value}")


def patch_boolean_tag(payload: bytes, tag: bytes, enabled: int | None, label: str) -> tuple[bytes, int]:
    if enabled is None:
        return payload, 0

    tag_index = payload.find(tag)
    if tag_index == -1:
        raise ValueError(f"level.dat does not contain the expected {label} tag")

    value_offset = tag_index + len(tag)
    current_value = payload[value_offset]
    if current_value == enabled:
        return payload, 0

    patched_payload = payload[:value_offset] + bytes([enabled]) + payload[value_offset + 1:]
    return patched_payload, 1


def patch_allow_cheats(payload: bytes, allow_cheats: str | None) -> tuple[bytes, int]:
    enabled = parse_boolean_flag(allow_cheats)
    patched_payload = payload
    patch_count = 0

    for tag, label in (
        (CHEATS_ENABLED_TAG, "cheatsEnabled"),
        (COMMANDS_ENABLED_TAG, "commandsEnabled"),
    ):
        patched_payload, applied = patch_boolean_tag(patched_payload, tag, enabled, label)
        patch_count += applied

    return patched_payload, patch_count


def patch_level_dat(
    path_str: str,
    level_name: str | None = None,
    difficulty: str | None = None,
    allow_cheats: str | None = None,
) -> int:
    path = Path(path_str)
    if not path.exists():
        return 0

    data = path.read_bytes()
    if len(data) < 8:
        raise ValueError(f"{path} is too short to be a Bedrock level.dat file")

    version = struct.unpack_from("<I", data, 0)[0]
    payload_len = struct.unpack_from("<I", data, 4)[0]
    payload = data[8:]

    if payload_len != len(payload):
        raise ValueError(f"{path} has an unexpected payload length header")

    patched_payload = payload
    patch_count = 0

    if NEW_EXPERIMENTS_BLOCK not in patched_payload:
        index = patched_payload.find(OLD_EXPERIMENTS_BLOCK)
        if index == -1:
            raise ValueError(f"{path} does not contain the expected experiments block")
        patched_payload = patched_payload.replace(OLD_EXPERIMENTS_BLOCK, NEW_EXPERIMENTS_BLOCK, 1)
        patch_count += 1

    patched_payload, rename_count = patch_level_name(patched_payload, level_name)
    patch_count += rename_count

    patched_payload, difficulty_count = patch_difficulty(patched_payload, difficulty)
    patch_count += difficulty_count

    patched_payload, allow_cheats_count = patch_allow_cheats(patched_payload, allow_cheats)
    patch_count += allow_cheats_count

    if patch_count == 0:
        return 0

    patched = struct.pack("<I", version) + struct.pack("<I", len(patched_payload)) + patched_payload
    path.write_bytes(patched)
    return patch_count


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(
            "usage: patch_level_dat.py [--level-name NAME] [--difficulty LEVEL] [--allow-cheats true|false] <path> [<path> ...]",
            file=sys.stderr,
        )
        return 2

    level_name: str | None = None
    difficulty: str | None = None
    allow_cheats: str | None = None
    candidates = argv[1:]

    while len(candidates) >= 2 and candidates[0].startswith("--"):
        option = candidates[0]
        value = candidates[1]

        if option == "--level-name":
            level_name = value
        elif option == "--difficulty":
            difficulty = value
        elif option == "--allow-cheats":
            allow_cheats = value
        else:
            print(f"unknown option: {option}", file=sys.stderr)
            return 2

        candidates = candidates[2:]

    if not candidates:
        print(
            "usage: patch_level_dat.py [--level-name NAME] [--difficulty LEVEL] [--allow-cheats true|false] <path> [<path> ...]",
            file=sys.stderr,
        )
        return 2

    patched_count = 0
    for candidate in candidates:
        patched_count += patch_level_dat(candidate, level_name, difficulty, allow_cheats)

    print(f"patched={patched_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
