"""Synchronous Open-Meteo Forecast API client with normalized responses.

Open-Meteo (https://open-meteo.com/en/docs) is free for **non-commercial**
use without an API key. Data are licensed **CC BY 4.0** and attribution to
"Open-Meteo.com" is required. Commercial use needs a separate Open-Meteo
Commercial license - nothing here implies free commercial use.

Only the standard library is used, and transport is injectable so tests
never touch the network::

    service = WeatherService()
    forecast = service.get_forecast(52.52, 13.41, days=3)
"""

from __future__ import annotations

import json
import math
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Mapping, Sequence

__all__ = [
    "WeatherService",
    "WeatherError",
    "DEFAULT_BASE_URL",
    "MAX_FORECAST_DAYS",
]

DEFAULT_BASE_URL = "https://api.open-meteo.com/v1/forecast"
MAX_FORECAST_DAYS = 7
DEFAULT_TIMEOUT = 10.0
CURRENT_FIELDS = ("temperature_2m", "weather_code", "wind_speed_10m")
DAILY_FIELDS = (
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_probability_max",
)


class WeatherError(RuntimeError):
    """Upstream HTTP/URL, malformed-JSON, or response-shape failure."""


def _decode_json(payload: Any) -> Mapping[str, Any]:
    """Decode bytes/str/mapping input into a JSON object mapping."""
    if isinstance(payload, bytes):
        try:
            payload = payload.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise WeatherError(f"upstream payload is not valid UTF-8: {exc}") from exc
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError as exc:
            raise WeatherError(f"upstream returned malformed JSON: {exc}") from exc
    if not isinstance(payload, Mapping):
        raise WeatherError("upstream JSON payload must be an object")
    return payload


def _default_http_get(url: str, timeout: float) -> Mapping[str, Any]:
    """Fetch ``url`` with ``urllib.request`` and return a decoded JSON object.

    Raises :class:`WeatherError` for non-200 status, transport, and
    decoding failures. Input validation errors are raised earlier, by
    :meth:`WeatherService.get_forecast`, as ``ValueError``.
    """
    request = urllib.request.Request(url, headers={"User-Agent": "social-mcp-smoke/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = int(getattr(response, "status", 200) or 200)
            if status != 200:
                raise WeatherError(f"upstream returned HTTP {status}")
            payload = response.read()
    except urllib.error.HTTPError as exc:
        raise WeatherError(f"upstream returned HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise WeatherError(f"forecast request failed: {exc}") from exc
    return _decode_json(payload)


def _require_number(container: Mapping[str, Any], key: str, context: str) -> float:
    value = container.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise WeatherError(f"{context} is missing numeric field '{key}'")
    if not math.isfinite(value):
        raise WeatherError(f"{context} field '{key}' is not finite")
    return float(value)


def _require_list(container: Mapping[str, Any], key: str, context: str) -> list[Any]:
    value = container.get(key)
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise WeatherError(f"{context} is missing array field '{key}'")
    return list(value)


def _validate_inputs(latitude: Any, longitude: Any, days: Any) -> tuple[float, float, int]:
    for name, value, limit in (("latitude", latitude, 90.0), ("longitude", longitude, 180.0)):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{name} must be a number")
        if not math.isfinite(value):
            raise ValueError(f"{name} must be finite")
        if not -limit <= value <= limit:
            raise ValueError(f"{name} must be between -{limit:g} and {limit:g}")
    if isinstance(days, bool) or not isinstance(days, int):
        raise ValueError("days must be an integer")
    if not 1 <= days <= MAX_FORECAST_DAYS:
        raise ValueError(f"days must be between 1 and {MAX_FORECAST_DAYS}")
    return float(latitude), float(longitude), int(days)


def _normalize(body: Mapping[str, Any], days: int) -> dict[str, Any]:
    """Validate the required Open-Meteo shape and return a normalized dict."""
    location = {
        "latitude": _require_number(body, "latitude", "response"),
        "longitude": _require_number(body, "longitude", "response"),
    }
    timezone = body.get("timezone")
    if not isinstance(timezone, str) or not timezone.strip():
        raise WeatherError("response is missing string field 'timezone'")

    current_raw = body.get("current")
    if not isinstance(current_raw, Mapping):
        raise WeatherError("response is missing object field 'current'")
    weather_code = current_raw.get("weather_code")
    if isinstance(weather_code, bool) or not isinstance(weather_code, int):
        raise WeatherError("current is missing integer field 'weather_code'")
    current = {
        "temperature": _require_number(current_raw, "temperature_2m", "current"),
        "weather_code": int(weather_code),
        "wind_speed": _require_number(current_raw, "wind_speed_10m", "current"),
    }

    daily_raw = body.get("daily")
    if not isinstance(daily_raw, Mapping):
        raise WeatherError("response is missing object field 'daily'")
    dates = _require_list(daily_raw, "time", "daily")
    if not 1 <= len(dates) <= days:
        raise WeatherError(f"daily 'time' array must contain 1..{days} entries")
    columns = {name: _require_list(daily_raw, name, "daily") for name in DAILY_FIELDS}
    for name, values in columns.items():
        if len(values) != len(dates):
            raise WeatherError(f"daily array '{name}' is misaligned with 'time'")

    entries: list[dict[str, Any]] = []
    for index, date in enumerate(dates):
        if not isinstance(date, str) or not date.strip():
            raise WeatherError(f"daily 'time' entry {index} is not a date string")
        entries.append(
            {
                "date": date,
                "temperature_min": _number_at(columns["temperature_2m_min"], index, "temperature_2m_min"),
                "temperature_max": _number_at(columns["temperature_2m_max"], index, "temperature_2m_max"),
                "precipitation_probability": _number_at(
                    columns["precipitation_probability_max"],
                    index,
                    "precipitation_probability_max",
                ),
            }
        )

    current_units = body.get("current_units") if isinstance(body.get("current_units"), Mapping) else {}
    daily_units = body.get("daily_units") if isinstance(body.get("daily_units"), Mapping) else {}
    units: dict[str, str] = {
        "temperature": str(current_units.get("temperature_2m") or "°C"),
        "wind_speed": str(current_units.get("wind_speed_10m") or "km/h"),
        "precipitation_probability": str(daily_units.get("precipitation_probability_max") or "%"),
    }

    return {
        "location": location,
        "timezone": timezone,
        "units": units,
        "current": current,
        "daily": entries,
    }


def _number_at(values: list[Any], index: int, name: str) -> float:
    value = values[index]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise WeatherError(f"daily array '{name}' entry {index} is not numeric")
    if not math.isfinite(value):
        raise WeatherError(f"daily array '{name}' entry {index} is not finite")
    return float(value)


class WeatherService:
    """Build Open-Meteo forecast requests and normalize their responses."""

    def __init__(
        self,
        http_get: Callable[[str, float], Any] | None = None,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
            raise ValueError("timeout must be a number")
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be a positive finite number")
        if not isinstance(base_url, str) or not base_url.startswith("https://"):
            raise ValueError("base_url must be an https:// URL")
        self._http_get: Callable[[str, float], Any] = http_get or _default_http_get
        self._base_url = base_url.rstrip("/")
        self._timeout = float(timeout)

    def build_url(self, latitude: float, longitude: float, days: int = 3) -> str:
        """Validate inputs and build the URL-encoded Open-Meteo request URL."""
        lat, lon, forecast_days = _validate_inputs(latitude, longitude, days)
        params = {
            "latitude": lat,
            "longitude": lon,
            "current": ",".join(CURRENT_FIELDS),
            "daily": ",".join(DAILY_FIELDS),
            "timezone": "auto",
            "forecast_days": forecast_days,
        }
        return f"{self._base_url}?{urllib.parse.urlencode(params)}"

    def get_forecast(self, latitude: float, longitude: float, days: int = 3) -> dict[str, Any]:
        """Return a normalized forecast dict for a coordinate pair.

        ``ValueError`` signals invalid inputs; :class:`WeatherError` signals
        upstream HTTP/URL failures, malformed JSON, or missing/misaligned
        required arrays.
        """
        url = self.build_url(latitude, longitude, days)
        payload = self._http_get(url, self._timeout)
        if isinstance(payload, Exception):
            raise payload
        body = _decode_json(payload)
        return _normalize(body, days=days)
