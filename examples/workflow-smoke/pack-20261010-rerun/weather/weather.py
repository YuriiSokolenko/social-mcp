"""Synchronous Open-Meteo forecast client (disposable workflow smoke artefact).

Queries the keyless Open-Meteo Forecast API (``https://api.open-meteo.com/v1/forecast``)
and normalises the response into a small JSON-safe dict. Source:
https://open-meteo.com/en/docs and https://github.com/open-meteo/open-meteo.

This file is a disposable workflow smoke artefact: it is not product code, is not
imported by the MCP server, and is removed by a separate scoped cleanup PR.

Documented policy choices
-------------------------
* Input validation raises :class:`ValueError`: ``latitude`` must be finite and in
  ``[-90, 90]``, ``longitude`` finite and in ``[-180, 180]``, ``days`` an ``int``
  in ``[1, 7]``. ``bool`` is rejected everywhere (it is not a coordinate or count).
* Everything upstream raises :class:`WeatherServiceError`: transport failure,
  non-2xx responses, non-JSON bodies, and missing / mis-aligned required arrays.
  The originating exception is chained with ``raise ... from exc`` and payloads
  are truncated so raw bodies are never echoed in full.
* HTTP goes through a single injectable seam (``fetch=``); tests inject a stub and
  never touch a socket. The default fetcher uses :mod:`urllib.request` with a
  fixed ``DEFAULT_TIMEOUT``. There are no retries, caching, or redirects beyond
  what ``urllib`` itself does.
* The query string is built only with :func:`urllib.parse.urlencode`; coordinates
  are never interpolated into the URL by hand.
* Unit strings come from the upstream ``current_units`` / ``daily_units`` blocks
  and fall back to the documented Open-Meteo defaults when those blocks are absent.
* ``precipitation_probability_max`` is legitimately ``null`` upstream, so ``None``
  is accepted for that one field and normalised to ``None``.
* ``weather_code`` is returned unchanged as an Open-Meteo WMO code (see README).
"""

from __future__ import annotations

import json
import math
import sys
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any
from urllib.parse import urlencode

FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast"
CURRENT_FIELDS = "temperature_2m,weather_code,wind_speed_10m"
DAILY_FIELDS = "temperature_2m_max,temperature_2m_min,precipitation_probability_max"
DEFAULT_DAYS = 3
MIN_DAYS = 1
MAX_DAYS = 7
DEFAULT_TIMEOUT = 10.0
MAX_ECHO_CHARS = 120

DEFAULT_UNITS = {
    "temperature": "°C",
    "wind_speed": "km/h",
    "precipitation_probability": "%",
}

Fetcher = Callable[[str], bytes]


class WeatherServiceError(Exception):
    """Raised for every upstream problem: transport, HTTP, JSON, and schema."""


def _clip(value: Any) -> str:
    text = value if isinstance(value, str) else repr(value)
    if len(text) > MAX_ECHO_CHARS:
        return f"{text[:MAX_ECHO_CHARS]}..."
    return text


def _default_fetch(url: str) -> bytes:
    """Fetch *url* with :mod:`urllib.request` and a fixed timeout."""
    try:
        with urllib.request.urlopen(url, timeout=DEFAULT_TIMEOUT) as response:  # noqa: S310
            body = response.read()
    except urllib.error.HTTPError as exc:
        raise WeatherServiceError(f"Open-Meteo returned HTTP {exc.code} {_clip(exc.reason)}") from exc
    except urllib.error.URLError as exc:
        raise WeatherServiceError(f"Open-Meteo request failed: {_clip(exc.reason)}") from exc
    except OSError as exc:
        raise WeatherServiceError(f"Open-Meteo request failed: {_clip(exc)}") from exc
    if not isinstance(body, (bytes, bytearray)):
        raise WeatherServiceError(f"Open-Meteo transport returned unexpected body type {type(body).__name__}")
    return bytes(body)


def _validate_coordinate(name: str, value: Any, limit: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number, got {value!r}")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{name} must be finite, got {value!r}")
    if not -limit <= number <= limit:
        raise ValueError(f"{name} must be between {-limit} and {limit}, got {value!r}")
    return number


def _validate_days(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"days must be an int between {MIN_DAYS} and {MAX_DAYS}, got {value!r}")
    if not MIN_DAYS <= value <= MAX_DAYS:
        raise ValueError(f"days must be between {MIN_DAYS} and {MAX_DAYS}, got {value!r}")
    return value


def build_request_url(latitude: float, longitude: float, days: int = DEFAULT_DAYS) -> str:
    """Return the Open-Meteo forecast URL for validated *latitude* / *longitude*.

    Parameters are encoded with :func:`urllib.parse.urlencode`, so coordinates are
    never spliced into the query string by hand.
    """
    lat = _validate_coordinate("latitude", latitude, 90.0)
    lon = _validate_coordinate("longitude", longitude, 180.0)
    count = _validate_days(days)
    params = {
        "latitude": repr(lat),
        "longitude": repr(lon),
        "current": CURRENT_FIELDS,
        "daily": DAILY_FIELDS,
        "timezone": "auto",
        "forecast_days": str(count),
    }
    return f"{FORECAST_ENDPOINT}?{urlencode(params)}"


def _section(payload: dict[str, Any], key: str) -> dict[str, Any]:
    section = payload.get(key)
    if not isinstance(section, dict):
        raise WeatherServiceError(f"Open-Meteo payload is missing required object {key!r}")
    return section


def _field(source: dict[str, Any], key: str, field: str) -> Any:
    if key not in source:
        raise WeatherServiceError(f"Open-Meteo payload is missing required field {field!r}")
    return source[key]


def _as_float(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise WeatherServiceError(f"Open-Meteo field {field!r} must be a number, got {_clip(value)}")
    number = float(value)
    if not math.isfinite(number):
        raise WeatherServiceError(f"Open-Meteo field {field!r} must be finite, got {_clip(value)}")
    return number


def _as_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise WeatherServiceError(f"Open-Meteo field {field!r} must be an integer, got {_clip(value)}")
    number = float(value)
    if not math.isfinite(number) or not number.is_integer():
        raise WeatherServiceError(f"Open-Meteo field {field!r} must be an integer, got {_clip(value)}")
    return int(number)


def _as_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise WeatherServiceError(
            f"Open-Meteo field {field!r} must be a non-empty string, got {_clip(value)}"
        )
    return value


def _as_array(section: dict[str, Any], key: str, field: str) -> list[Any]:
    if key not in section:
        raise WeatherServiceError(f"Open-Meteo payload is missing required array {field!r}")
    value = section[key]
    if not isinstance(value, list):
        raise WeatherServiceError(f"Open-Meteo field {field!r} must be a list, got {type(value).__name__}")
    return value


def _unit(units: dict[str, Any], key: str, fallback: str) -> str:
    value = units.get(key)
    return value if isinstance(value, str) and value.strip() else fallback


def _normalize_current(current: dict[str, Any]) -> dict[str, Any]:
    return {
        "temperature": _as_float(
            _field(current, "temperature_2m", "current.temperature_2m"), "current.temperature_2m"
        ),
        "weather_code": _as_int(
            _field(current, "weather_code", "current.weather_code"), "current.weather_code"
        ),
        "wind_speed": _as_float(
            _field(current, "wind_speed_10m", "current.wind_speed_10m"), "current.wind_speed_10m"
        ),
    }


def _normalize_daily(daily: dict[str, Any], days: int) -> list[dict[str, Any]]:
    times = _as_array(daily, "time", "daily.time")
    maxima = _as_array(daily, "temperature_2m_max", "daily.temperature_2m_max")
    minima = _as_array(daily, "temperature_2m_min", "daily.temperature_2m_min")
    probabilities = _as_array(
        daily, "precipitation_probability_max", "daily.precipitation_probability_max"
    )
    if not len(times) == len(maxima) == len(minima) == len(probabilities):
        raise WeatherServiceError(
            "Open-Meteo daily arrays are mis-aligned: "
            f"time={len(times)}, temperature_2m_max={len(maxima)}, "
            f"temperature_2m_min={len(minima)}, precipitation_probability_max={len(probabilities)}"
        )
    if len(times) != days:
        raise WeatherServiceError(f"Open-Meteo returned {len(times)} daily entries, expected {days}")
    entries: list[dict[str, Any]] = []
    for index in range(len(times)):
        probability = probabilities[index]
        entries.append(
            {
                "date": _as_text(times[index], f"daily.time[{index}]"),
                "temperature_max": _as_float(maxima[index], f"daily.temperature_2m_max[{index}]"),
                "temperature_min": _as_float(minima[index], f"daily.temperature_2m_min[{index}]"),
                "precipitation_probability": (
                    None
                    if probability is None
                    else _as_float(probability, f"daily.precipitation_probability_max[{index}]")
                ),
            }
        )
    return entries


def _units_section(payload: dict[str, Any]) -> dict[str, str]:
    current_units = payload.get("current_units")
    daily_units = payload.get("daily_units")
    if not isinstance(current_units, dict):
        current_units = {}
    if not isinstance(daily_units, dict):
        daily_units = {}
    return {
        "temperature": _unit(current_units, "temperature_2m", DEFAULT_UNITS["temperature"]),
        "wind_speed": _unit(current_units, "wind_speed_10m", DEFAULT_UNITS["wind_speed"]),
        "precipitation_probability": _unit(
            daily_units, "precipitation_probability_max", DEFAULT_UNITS["precipitation_probability"]
        ),
    }


def _normalize(payload: Any, latitude: float, longitude: float, days: int) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise WeatherServiceError(
            f"Open-Meteo payload must be a JSON object, got {type(payload).__name__}"
        )
    current = _section(payload, "current")
    daily = _section(payload, "daily")
    return {
        "location": {"latitude": latitude, "longitude": longitude},
        "timezone": _as_text(_field(payload, "timezone", "timezone"), "timezone"),
        "units": _units_section(payload),
        "current": _normalize_current(current),
        "daily": _normalize_daily(daily, days),
        "days": days,
    }


def get_forecast(
    latitude: float,
    longitude: float,
    days: int = DEFAULT_DAYS,
    *,
    fetch: Fetcher | None = None,
) -> dict[str, Any]:
    """Return a normalised Open-Meteo forecast for *latitude* / *longitude*.

    Validates inputs first (``ValueError``), builds the request URL with
    :func:`urllib.parse.urlencode`, calls the injected *fetch* (defaults to
    :func:`_default_fetch`), decodes the JSON body, and normalises it into
    ``location`` / ``timezone`` / ``units`` / ``current`` / ``daily`` / ``days``.
    Every upstream problem raises :class:`WeatherServiceError`.
    """
    lat = _validate_coordinate("latitude", latitude, 90.0)
    lon = _validate_coordinate("longitude", longitude, 180.0)
    count = _validate_days(days)
    url = build_request_url(lat, lon, count)
    fetcher = fetch or _default_fetch
    try:
        body = fetcher(url)
    except WeatherServiceError:
        raise
    except Exception as exc:  # noqa: BLE001 - one public error for every transport failure
        raise WeatherServiceError(f"Open-Meteo request failed: {_clip(exc)}") from exc
    if isinstance(body, (bytes, bytearray)):
        try:
            text = bytes(body).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise WeatherServiceError("Open-Meteo returned a non-UTF-8 body") from exc
    elif isinstance(body, str):
        text = body
    else:
        raise WeatherServiceError(
            f"Open-Meteo transport returned unexpected body type {type(body).__name__}"
        )
    try:
        payload = json.loads(text)
    except ValueError as exc:
        raise WeatherServiceError(
            f"Open-Meteo returned malformed JSON: {_clip(exc.msg)}"
        ) from exc
    return _normalize(payload, lat, lon, count)


def render_json(forecast: dict[str, Any]) -> str:
    """Render *forecast* as stable, sorted JSON terminated by a newline."""
    return json.dumps(forecast, indent=2, sort_keys=True) + "\n"


def main(argv: list[str] | None = None, *, fetch: Fetcher | None = None) -> int:
    """CLI entry point: ``0`` success, ``2`` invalid input, ``3`` upstream failure."""
    import argparse

    parser = argparse.ArgumentParser(
        prog="weather",
        description="Fetch a normalised Open-Meteo forecast as JSON (non-commercial use).",
    )
    parser.add_argument("--latitude", type=float, required=True, help="WGS84 latitude, -90..90")
    parser.add_argument("--longitude", type=float, required=True, help="WGS84 longitude, -180..180")
    parser.add_argument(
        "--days",
        type=int,
        default=DEFAULT_DAYS,
        help=f"forecast days, {MIN_DAYS}..{MAX_DAYS} (default {DEFAULT_DAYS})",
    )
    args = parser.parse_args(argv)
    try:
        forecast = get_forecast(args.latitude, args.longitude, args.days, fetch=fetch)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except WeatherServiceError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 3
    sys.stdout.write(render_json(forecast))
    return 0


if __name__ == "__main__":
    sys.exit(main())
