"""Open-Meteo Forecast API wrapper for the disposable workflow smoke test.

A small, synchronous, standard-library-only weather service. This is smoke-test
scaffolding rather than product code: it is intentionally free of retries,
caching, sessions, and framework wiring.

Open-Meteo's Forecast API needs no API key for non-commercial use, but that
free tier is not a commercial licence. See the adjacent ``README.md`` for the
CC BY 4.0 attribution and the commercial-use caveat.
"""

from __future__ import annotations

import json
import math
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any
from urllib.parse import urlencode

__all__ = ["WeatherService", "WeatherServiceError"]

ENDPOINT = "https://api.open-meteo.com/v1/forecast"
CURRENT_FIELDS = "temperature_2m,weather_code,wind_speed_10m"
DAILY_FIELDS = "temperature_2m_max,temperature_2m_min,precipitation_probability_max"
DEFAULT_TIMEOUT = 10.0
MAX_DAYS = 7


class WeatherServiceError(Exception):
    """Raised when the upstream call, payload, or payload schema is unusable.

    Input validation never raises this type: invalid arguments to
    :meth:`WeatherService.get_forecast` raise ``ValueError`` instead.
    """


class WeatherService:
    """Read normalized forecast data from the Open-Meteo Forecast API.

    Transport is injectable so tests stay deterministic and never touch the
    network; the default getter uses :mod:`urllib.request` with a timeout.
    Upstream HTTP/URL failures, malformed JSON, and missing or misaligned
    response arrays are reported as :class:`WeatherServiceError`.
    """

    def __init__(
        self,
        http_get: Callable[[str], bytes] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        """``http_get`` defaults to a ``urlopen``-backed getter, ``timeout`` its seconds."""
        self._http_get = http_get if http_get is not None else _urlopen_get(timeout)
        self._timeout = timeout

    def get_forecast(self, latitude: float, longitude: float, days: int = 3) -> dict[str, Any]:
        """Return a normalized forecast for ``days`` days at the given position.

        Raises ``ValueError`` for non-finite coordinates, coordinates outside
        +/-90 or +/-180, or ``days`` outside 1..7. Raises
        :class:`WeatherServiceError` for transport, JSON, or schema problems.
        """
        self._validate(latitude, longitude, days)
        url = self._build_url(latitude, longitude, days)
        payload = self._fetch(url)
        return self._normalize(payload, latitude, longitude, days)

    @staticmethod
    def _validate(latitude: float, longitude: float, days: int) -> None:
        """Reject arguments that cannot produce a meaningful upstream request."""
        for name, value in (("latitude", latitude), ("longitude", longitude)):
            if not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"{name} must be a finite number, got {value!r}")
        if abs(latitude) > 90:
            raise ValueError(f"latitude must be between -90 and 90, got {latitude!r}")
        if abs(longitude) > 180:
            raise ValueError(f"longitude must be between -180 and 180, got {longitude!r}")
        # ``bool`` is an ``int`` subclass but never a meaningful day count.
        if isinstance(days, bool) or not isinstance(days, int):
            raise ValueError(f"days must be an integer between 1 and {MAX_DAYS}, got {days!r}")
        if not 1 <= days <= MAX_DAYS:
            raise ValueError(f"days must be between 1 and {MAX_DAYS}, got {days!r}")

    @staticmethod
    def _build_url(latitude: float, longitude: float, days: int) -> str:
        """Build the upstream request URL, escaping every value with ``urlencode``."""
        params = {
            "latitude": f"{latitude}",
            "longitude": f"{longitude}",
            "current": CURRENT_FIELDS,
            "daily": DAILY_FIELDS,
            "timezone": "auto",
            "forecast_days": f"{days}",
        }
        return f"{ENDPOINT}?{urlencode(params)}"

    def _fetch(self, url: str) -> Any:
        """Return the decoded JSON object behind ``url``.

        Transport and JSON problems surface as :class:`WeatherServiceError`
        instead of leaking ``urllib`` or ``json`` exception types.
        """
        try:
            body = self._http_get(url)
        except (urllib.error.HTTPError, urllib.error.URLError, OSError) as exc:
            raise WeatherServiceError(f"weather request to {url} failed: {exc}") from exc
        try:
            payload = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            message = f"weather response from {url} is not valid JSON"
            raise WeatherServiceError(message) from exc
        if not isinstance(payload, dict):
            raise WeatherServiceError(f"weather response from {url} must be a JSON object")
        return payload

    def _normalize(
        self,
        payload: dict[str, Any],
        latitude: float,
        longitude: float,
        days: int,
    ) -> dict[str, Any]:
        """Project the upstream payload onto the stable public dictionary shape."""
        current = _mapping(payload, "current")
        daily = _mapping(payload, "daily")
        current_units = payload.get("current_units")
        daily_units = payload.get("daily_units")
        units = {
            "temperature": _unit_label(current_units, "temperature_2m"),
            "wind_speed": _unit_label(current_units, "wind_speed_10m"),
            "precipitation_probability": _unit_label(
                daily_units, "precipitation_probability_max"
            ),
        }
        return {
            "location": {"latitude": float(latitude), "longitude": float(longitude)},
            "timezone": _text(payload.get("timezone"), "timezone"),
            "units": units,
            "current": {
                "temperature": _number(current.get("temperature_2m"), "temperature_2m"),
                "weather_code": _exact_int(current.get("weather_code"), "weather_code"),
                "wind_speed": _number(current.get("wind_speed_10m"), "wind_speed_10m"),
            },
            "daily": _daily(daily, days),
        }


def _mapping(payload: dict[str, Any], key: str) -> dict[str, Any]:
    """Return the required top-level ``key`` object."""
    value = payload.get(key)
    if not isinstance(value, dict):
        raise WeatherServiceError(f"weather response is missing '{key}'")
    return value


def _unit_label(units: Any, key: str) -> str:
    """Read one unit label, returning an empty string when Open-Meteo omits it."""
    if not isinstance(units, dict):
        return ""
    value = units.get(key)
    return value if isinstance(value, str) else ""


def _text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise WeatherServiceError(f"weather response '{name}' must be a non-empty string")
    return value


def _number(value: Any, name: str) -> float:
    """Return ``value`` as ``float``, rejecting booleans and non-numbers."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise WeatherServiceError(f"weather response '{name}' must be a number")
    return float(value)


def _exact_int(value: Any, name: str) -> int:
    """Return ``value`` as ``int`` only when it really is an integer."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise WeatherServiceError(f"weather response '{name}' must be an integer")
    return value


def _list(payload: dict[str, Any], key: str) -> list[Any]:
    """Return the required aligned ``daily`` array."""
    value = payload.get(key)
    if not isinstance(value, list):
        raise WeatherServiceError(f"weather response is missing daily.{key}")
    return value


def _daily(daily: dict[str, Any], days: int) -> list[dict[str, Any]]:
    """Zip the aligned daily arrays into one normalized entry per day."""
    time = _list(daily, "time")
    if len(time) != days:
        raise WeatherServiceError(
            f"daily.time has {len(time)} entries but {days} were requested"
        )
    temperature_min = _list(daily, "temperature_2m_min")
    temperature_max = _list(daily, "temperature_2m_max")
    probability = _list(daily, "precipitation_probability_max")
    for name, values in (
        ("temperature_2m_min", temperature_min),
        ("temperature_2m_max", temperature_max),
        ("precipitation_probability_max", probability),
    ):
        if len(values) != len(time):
            raise WeatherServiceError(
                f"daily.{name} has {len(values)} entries but daily.time has {len(time)}"
            )

    entries: list[dict[str, Any]] = []
    for index, date in enumerate(time):
        raw_probability = probability[index]
        entry: dict[str, Any] = {
            "date": _text(date, "daily.time"),
            "temperature_min": _number(temperature_min[index], "temperature_2m_min"),
            "temperature_max": _number(temperature_max[index], "temperature_2m_max"),
            "precipitation_probability": (
                None
                if raw_probability is None
                else _exact_int(raw_probability, "precipitation_probability_max")
            ),
        }
        entries.append(entry)
    return entries


def _urlopen_get(timeout: float) -> Callable[[str], bytes]:
    """Return the default ``urllib.request``-backed transport getter."""

    def get(url: str) -> bytes:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.read()

    return get