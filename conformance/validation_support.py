from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from jsonschema import FormatChecker


REPO_ROOT = Path(__file__).resolve().parents[1]
FORMAT_CHECKER = FormatChecker()
UTC_DATETIME = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$"
)
URI_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*$")


@FORMAT_CHECKER.checks("date-time")
def is_utc_datetime(value: object) -> bool:
    if not isinstance(value, str):
        return True
    if not UTC_DATETIME.fullmatch(value):
        return False
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return True


@FORMAT_CHECKER.checks("uri")
def is_uri(value: object) -> bool:
    if not isinstance(value, str):
        return True
    if not value or any(character.isspace() for character in value):
        return False
    return bool(URI_SCHEME.fullmatch(urlsplit(value).scheme))


@FORMAT_CHECKER.checks("uri-reference")
def is_uri_reference(value: object) -> bool:
    if not isinstance(value, str):
        return True
    if not value or any(character.isspace() for character in value):
        return False
    try:
        urlsplit(value)
    except ValueError:
        return False
    return True


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def flatten_errors(error: Any) -> list[Any]:
    if not error.context:
        return [error]
    leaves: list[Any] = []
    for child in error.context:
        leaves.extend(flatten_errors(child))
    return leaves


def describe_errors(errors: list[Any], limit: int = 6) -> str:
    leaves: list[Any] = []
    for error in errors:
        leaves.extend(flatten_errors(error))
    unique: list[str] = []
    for error in leaves:
        path = "/" + "/".join(str(part) for part in error.absolute_path)
        message = f"{path}: {error.message}"
        if message not in unique:
            unique.append(message)
    return "\n      ".join(unique[:limit])
