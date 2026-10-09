"""Synchronous weather lookup around the public Open-Meteo Forecast API.

Open-Meteo (https://open-meteo.com/en/docs, https://github.com/open-meteo/open-meteo)
exposes the forecast data used here. The API requires no API key **for
non-commercial use only**: the free tier is licensed under CC BY 4.0
(attribution to Open-Meteo required) and commercial use needs a separate paid
Open-Meteo licence. Nothing in this module grants or implies commercial use.

This is a disposable workflow smoke-test example, not production code.
"""

from __future__ import annotations

import json
import math
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from functools import partial
from typing import Any

DEFAULT_BASE_URL = "https://api.open-meteo.com/v1/forecast"
DEFAULT_TIMEOUT = 10.0

CURRENT_FIELDS = "temperature_2m,weather_code,wind_speed_10m"
DAILY_FIELDS = "temperature_2m_max,temperature_2m_min,precipitation_probability_max"


class WeatherServiceError(Exception):
    """Upstream transport, HTTP, or JSON decoding failure."""


def _check_finite(value: Any, name: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a number, got {value!r}") from exc
    if not math.isfinite(number):
        raise ValueError(f"{name} must be finite, got {value!r}")
    return number


def _validate_coordinates(latitude: float, longitude: float) -> tuple[float, float]:
    lat = _check_finite(latitude, "latitude")
    lon = _check_finite(longitude, "longitude")
    if not -90.0 <= lat <= 90.0:
        raise ValueError(f"latitude must be between -90 and 90, got {latitude!r}")
    if not -180.0 <= lon <= 180.0:
        raise ValueError(f"longitude must be between -180 and 180, got {longitude!r}")
    return lat, lon


def _validate_days(days: int) -> int:
    if isinstance(days, bool) or not isinstance(days, int):
        raise ValueError(f"days must be an integer between 1 and 7, got {days!r}")
    if not 1 <= days <= 7:
        raise ValueError(f"days must be between 1 and 7, got {days!r}")
    return days


def build_forecast_url(
    latitude: float,
    longitude: float,
    days: int = 3,
    base_url: str = DEFAULT_BASE_URL,
) -> str:
    """Return the Open-Meteo request URL for one validated forecast request."""
    lat, lon = _validate_coordinates(latitude, longitude)
    params = {
        "latitude": f"{lat:.6f}",
        "longitude": f"{lon:.6f}",
        "current": CURRENT_FIELDS,
        "daily": DAILY_FIELDS,
        "timezone": "auto",
        "forecast_days": _validate_days(days),
    }
    return f"{base_url}?{urllib.parse.urlencode(params)}"


class WeatherService:
    """Small reusable client for the keyless Open-Meteo Forecast API.

    ``http_get`` may be injected (it receives a URL and returns decoded JSON)
    so the service can be exercised without any network access.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        http_get: Callable[[str], dict] | None = None,
    ) -> None:
        self.base_url = base_url
        self.timeout = timeout
        self._http_get = http_get

    def get_forecast(self, latitude: float, longitude: float, days: int = 3) -> dict:
        """Return a normalized forecast dict for the given position."""
        lat, lon = _validate_coordinates(latitude, longitude)
        days = _validate_days(days)
        url = build_forecast_url(lat, lon, days, base_url=self.base_url)
        getter = self._http_get or partial(_default_http_get, timeout=self.timeout)
        try:
            payload = getter(url)
        except (urllib.error.URLError, WeatherServiceError) as exc:
            if isinstance(exc, WeatherServiceError):
                raise
            raise WeatherServiceError(f"weather request to {url} failed: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise WeatherServiceError(f"weather response from {url} is not valid JSON: {exc}") from exc
        if not isinstance(payload, dict):
            raise WeatherServiceError("weather response must be a JSON object")
        return _normalize(payload, lat, lon, days)


def _default_http_get(url: str, timeout: float = DEFAULT_TIMEOUT) -> dict:
    """Fetch ``url`` with ``urllib.request`` and decode the JSON body.

    Upstream HTTP/URL problems and malformed JSON are reported as
    ``WeatherServiceError``; callers do not have to know about urllib.
    """
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise WeatherServiceError(f"upstream HTTP error {exc.code} for {url}") from exc
    except urllib.error.URLError as exc:
        raise WeatherServiceError(f"upstream transport failure for {url}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise WeatherServiceError(f"malformed JSON from {url}: {exc}") from exc


def _require_list(source: dict, key: str, context: str) -> list:
    value = source.get(key)
    if value is None:
        raise ValueError(f"weather response is missing {context}{key!r}")
    if not isinstance(value, list):
        raise ValueError(f"weather response {context}{key!r} must be a list")
    return value


def _daily_array(daily: dict, key: str, days: int) -> list:
    values = _require_list(daily, key, "daily.")
    if len(values) != days:
        raise ValueError(
            f"weather response daily.{key} has {len(values)} entries, expected {days}"
        )
    return values


def _normalize(payload: dict, latitude: float, longitude: float, days: int) -> dict:
    """Map an Open-Meteo payload onto the documented normalized structure."""
    current = payload.get("current")
    if not isinstance(current, dict):
        raise ValueError("weather response is missing 'current'")
    daily = payload.get("daily")
    if not isinstance(daily, dict):
        raise ValueError("weather response is missing 'daily'")

    current_values = {}
    for key in CURRENT_FIELDS.split(","):
        if key not in current:
            raise ValueError(f"weather response is missing current.{key!r}")
        current_values[key] = current[key]

    dates = _daily_array(daily, "time", days)
    max_temps = _daily_array(daily, "temperature_2m_max", days)
    min_temps = _daily_array(daily, "temperature_2m_min", days)
    probabilities = _daily_array(daily, "precipitation_probability_max", days)

    current_units = payload.get("current_units") or {}
    daily_units = payload.get("daily_units") or {}
    temperature = daily_units.get("temperature_2m_max", current_units.get("temperature_2m", "°C"))
    return {
        "location": {"latitude": latitude, "longitude": longitude},
        "timezone": payload.get("timezone"),
        "units": {
            "temperature": temperature,
            "wind_speed": current_units.get("wind_speed_10m", "km/h"),
            "precipitation_probability": daily_units.get("precipitation_probability_max", "%"),
        },
        "current": {
            "temperature": current_values["temperature_2m"],
            "weather_code": current_values["weather_code"],
            "wind_speed": current_values["wind_speed_10m"],
        },
        "daily": [
            {
                "date": dates[index],
                "temperature_max": max_temps[index],
                "temperature_min": min_temps[index],
                "precipitation_probability": probabilities[index],
            }
            for index in range(days)
        ],
    }


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("latitude", type=float)
    parser.add_argument("longitude", type=float)
    parser.add_argument("--days", type=int, default=3)
    args = parser.parse_args()
    service = WeatherService()
    try:
        print(json.dumps(service.get_forecast(args.latitude, args.longitude, args.days), indent=2))
    except (ValueError, WeatherServiceError) as exc:
        raise SystemExit(f"forecast failed: {exc}")
