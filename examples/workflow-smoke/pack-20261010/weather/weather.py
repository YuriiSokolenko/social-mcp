"""Synchronous Open-Meteo forecast client (disposable workflow smoke artefact).

A small, reusable, dependency-free client for the Open-Meteo Forecast API
``https://api.open-meteo.com/v1/forecast``. Open-Meteo needs no API key for
non-commercial use; see ``README.md`` for the attribution (CC BY 4.0) and
commercial-license caveats. Nothing here is wired into the product server.

    from weather import WeatherService

    forecast = WeatherService().get_forecast(52.52, 13.41, days=3)
    print(forecast["current"]["temperature_c"], forecast["daily"][0]["date"])

Documented policy choices
-------------------------
* Transport is injectable (``http_get``), so unit tests never touch the
  network. The default transport uses :mod:`urllib.request` with a bounded
  ``timeout`` and a static User-Agent; no secrets are ever sent.
* Input validation always raises :class:`ValueError` and happens *before* any
  request is built: finite latitude in +/-90, finite longitude in +/-180, and
  an ``int`` ``days`` (never ``bool``) in 1..7.
* Upstream failures raise :class:`WeatherServiceError` (an ``HTTPError``,
  ``URLError``, timeout, non-JSON body, non-dict body, missing ``timezone``,
  missing required daily arrays, or daily arrays whose lengths disagree).
  Raw urllib exceptions are wrapped, never leaked.
* The query string is built only with :func:`urllib.parse.urlencode`.
* Numeric fields are coerced to ``float``/``int``; ``None`` is preserved where
  Open-Meteo legitimately returns ``null`` (notably
  ``precipitation_probability_max``), because absence of data is meaningful.
* The service is synchronous and makes exactly one request per call.
"""

from __future__ import annotations

import json
import math
import urllib.error
import urllib.request
from datetime import date
from typing import Any, Protocol, runtime_checkable
from urllib.parse import urlencode

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
USER_AGENT = "workflow-smoke/1.0"
DEFAULT_TIMEOUT = 10.0
MIN_DAYS = 1
MAX_DAYS = 7
MIN_LATITUDE = -90.0
MAX_LATITUDE = 90.0
MIN_LONGITUDE = -180.0
MAX_LONGITUDE = 180.0

CURRENT_FIELDS = ("temperature_2m", "weather_code", "wind_speed_10m")
DAILY_FIELDS = (
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_probability_max",
)

__all__ = ["OPEN_METEO_URL", "WeatherService", "WeatherServiceError", "build_request_url"]


class WeatherServiceError(RuntimeError):
    """Raised when the upstream forecast request or payload is unusable."""


@runtime_checkable
class HttpGet(Protocol):
    """Minimal transport boundary: fetch *url* and return its raw body."""

    def __call__(self, url: str) -> "bytes | str": ...


def _validate_coordinates(latitude: Any, longitude: Any) -> tuple[float, float]:
    checked: dict[str, float] = {}
    for name, raw in (("latitude", latitude), ("longitude", longitude)):
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise ValueError(f"{name} must be a number, got {raw!r}")
        value = float(raw)
        if not math.isfinite(value):
            raise ValueError(f"{name} must be finite, got {raw!r}")
        checked[name] = value
    lat, lon = checked["latitude"], checked["longitude"]
    if not MIN_LATITUDE <= lat <= MAX_LATITUDE:
        raise ValueError(
            f"latitude must be between {MIN_LATITUDE:g} and {MAX_LATITUDE:g}, got {lat!r}"
        )
    if not MIN_LONGITUDE <= lon <= MAX_LONGITUDE:
        raise ValueError(
            f"longitude must be between {MIN_LONGITUDE:g} and {MAX_LONGITUDE:g}, got {lon!r}"
        )
    return lat, lon


def _validate_days(days: Any) -> int:
    if isinstance(days, bool) or not isinstance(days, int):
        raise ValueError(f"days must be an integer, got {days!r}")
    if not MIN_DAYS <= days <= MAX_DAYS:
        raise ValueError(f"days must be between {MIN_DAYS} and {MAX_DAYS}, got {days!r}")
    return days


def build_params(latitude: float, longitude: float, days: int) -> dict[str, str]:
    """Return the Open-Meteo query parameters for one validated forecast call."""
    return {
        "latitude": f"{latitude:.6f}",
        "longitude": f"{longitude:.6f}",
        "current": ",".join(CURRENT_FIELDS),
        "daily": ",".join(DAILY_FIELDS),
        "timezone": "auto",
        "forecast_days": str(days),
    }


def build_request_url(
    latitude: float,
    longitude: float,
    days: int,
    base_url: str = OPEN_METEO_URL,
) -> str:
    """Build the request URL with :func:`urlencode` (inputs validated by caller)."""
    query = urlencode(build_params(latitude, longitude, days))
    return f"{base_url}?{query}"


def _decode(body: "bytes | str", url: str) -> dict[str, Any]:
    """Decode and JSON-parse an upstream body, raising WeatherServiceError on failure."""
    if isinstance(body, bytes):
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise WeatherServiceError(f"upstream body is not valid UTF-8 for {url}") from exc
    elif isinstance(body, str):
        text = body
    else:
        raise WeatherServiceError(f"upstream body must be bytes or str for {url}")
    try:
        payload = json.loads(text)
    except (json.JSONDecodeError, ValueError) as exc:
        raise WeatherServiceError(f"upstream returned malformed JSON for {url}") from exc
    if not isinstance(payload, dict):
        raise WeatherServiceError(f"upstream returned a non-object body for {url}")
    return payload


def _require_str(payload: dict[str, Any], key: str, what: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise WeatherServiceError(f"upstream response is missing {what}")
    return value


def _require_section(payload: dict[str, Any], key: str) -> dict[str, Any]:
    section = payload.get(key)
    if not isinstance(section, dict):
        raise WeatherServiceError(f"upstream response is missing object '{key}'")
    return section


def _as_float(value: Any, field: str) -> "float | None":
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise WeatherServiceError(f"upstream field '{field}' must be a number, got {value!r}")
    return float(value)


def _require_series(daily: dict[str, Any], key: str, expected: int) -> list[Any]:
    if key not in daily:
        raise WeatherServiceError(f"upstream daily block is missing array '{key}'")
    value = daily[key]
    if isinstance(value, (str, bytes)) or not isinstance(value, (list, tuple)):
        raise WeatherServiceError(f"upstream daily field '{key}' must be an array, got {value!r}")
    if len(value) != expected:
        raise WeatherServiceError(
            f"upstream daily field '{key}' has length {len(value)}, expected {expected}"
        )
    return list(value)


def _require_number(section: dict[str, Any], field: str, kind: type[int] | type[float]) -> Any:
    """Read one required, non-null numeric *field* from an upstream object."""
    if field not in section:
        raise WeatherServiceError(f"upstream response is missing required field '{field}'")
    value = section[field]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise WeatherServiceError(f"upstream field '{field}' must be a number, got {value!r}")
    return kind(value)


def _normalize_current(current: dict[str, Any]) -> dict[str, Any]:
    return {
        "temperature_c": _require_number(current, "temperature_2m", float),
        "weather_code": _require_number(current, "weather_code", int),
        "wind_speed_kmh": _require_number(current, "wind_speed_10m", float),
    }


def _normalize_daily(daily: dict[str, Any], days: int) -> list[dict[str, Any]]:
    times = _require_series(daily, "time", days)
    maxima = _require_series(daily, "temperature_2m_max", days)
    minima = _require_series(daily, "temperature_2m_min", days)
    precipitation = _require_series(daily, "precipitation_probability_max", days)
    entries: list[dict[str, Any]] = []
    for index, raw_day in enumerate(times):
        if not isinstance(raw_day, str):
            raise WeatherServiceError(
                f"upstream daily field 'time[{index}]' must be a date string, got {raw_day!r}"
            )
        try:
            day = date.fromisoformat(raw_day)
        except ValueError as exc:
            raise WeatherServiceError(
                f"upstream daily field 'time[{index}]' is not an ISO date: {raw_day!r}"
            ) from exc
        entries.append(
            {
                "date": day.isoformat(),
                "temperature_max_c": _as_float(
                    maxima[index], f"daily.temperature_2m_max[{index}]"
                ),
                "temperature_min_c": _as_float(
                    minima[index], f"daily.temperature_2m_min[{index}]"
                ),
                "precipitation_probability_pct": _as_float(
                    precipitation[index], f"daily.precipitation_probability_max[{index}]"
                ),
            }
        )
    return entries


class WeatherService:
    """Read-only, synchronous client for the Open-Meteo Forecast API."""

    def __init__(
        self,
        *,
        http_get: "HttpGet | None" = None,
        timeout: float = DEFAULT_TIMEOUT,
        base_url: str = OPEN_METEO_URL,
    ) -> None:
        """Create a client; inject *http_get* in tests to avoid real requests."""
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
            raise ValueError(f"timeout must be a number, got {timeout!r}")
        if not math.isfinite(float(timeout)) or float(timeout) <= 0:
            raise ValueError(f"timeout must be a positive finite number, got {timeout!r}")
        if not isinstance(base_url, str) or not base_url.startswith("https://"):
            raise ValueError(f"base_url must be an https URL, got {base_url!r}")
        self.timeout = float(timeout)
        self.base_url = base_url
        self._http_get = http_get

    def _open(self, url: str) -> "bytes | str":
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            return response.read()

    def _fetch(self, url: str) -> "bytes | str":
        """Fetch *url*, mapping every transport failure to WeatherServiceError."""
        try:
            if self._http_get is not None:
                return self._http_get(url)
            return self._open(url)
        except urllib.error.HTTPError as exc:
            raise WeatherServiceError(f"upstream HTTP error {exc.code} for {url}") from exc
        except urllib.error.URLError as exc:
            raise WeatherServiceError(f"upstream request failed for {url}: {exc.reason}") from exc
        except OSError as exc:  # includes socket.timeout, the urllib timeout path
            raise WeatherServiceError(f"upstream request failed for {url}: {exc}") from exc

    def get_forecast(
        self,
        latitude: float,
        longitude: float,
        days: int = 3,
    ) -> dict[str, Any]:
        """Return a normalized forecast dict for one coordinate pair.

        Keys: ``latitude``, ``longitude``, ``timezone``, ``units``,
        ``current`` (temperature, weather code, wind speed) and ``daily``
        (exactly *days* entries with date, min/max temperature and
        precipitation probability).
        """
        lat, lon = _validate_coordinates(latitude, longitude)
        checked_days = _validate_days(days)
        url = build_request_url(lat, lon, checked_days, base_url=self.base_url)
        payload = _decode(self._fetch(url), url)
        timezone = _require_str(payload, "timezone", "a valid 'timezone'")
        current = _require_section(payload, "current")
        daily = _require_section(payload, "daily")
        current_units = _require_section(payload, "current_units")
        daily_units = _require_section(payload, "daily_units")
        units = {
            "temperature": _require_str(
                current_units, "temperature_2m", "units for 'temperature_2m'"
            ),
            "wind_speed": _require_str(
                current_units, "wind_speed_10m", "units for 'wind_speed_10m'"
            ),
            "precipitation_probability": _require_str(
                daily_units,
                "precipitation_probability_max",
                "units for 'precipitation_probability_max'",
            ),
        }
        result: dict[str, Any] = {
            "latitude": lat,
            "longitude": lon,
            "timezone": timezone,
            "units": units,
            "current": _normalize_current(current),
            "daily": _normalize_daily(daily, checked_days),
        }
        abbreviation = payload.get("timezone_abbreviation")
        if isinstance(abbreviation, str) and abbreviation.strip():
            result["timezone_abbreviation"] = abbreviation
        elevation = _as_float(payload.get("elevation"), "elevation")
        if elevation is not None:
            result["elevation_m"] = elevation
        return result
