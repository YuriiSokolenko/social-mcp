"""Reusable synchronous Open-Meteo weather service (disposable workflow smoke artefact).

Queries the keyless Open-Meteo Forecast API ``https://api.open-meteo.com/v1/forecast``
and normalises the response into a JSON-safe Python dict.

Licensing (read before reusing outside this smoke pack)
-------------------------------------------------------
Open-Meteo is free of charge for **non-commercial use only**, conditional on
attributing Open-Meteo as the data source (the raw data is licensed ``CC BY
4.0``). **Commercial use requires a separate Open-Meteo commercial licence**:
nothing in this module grants, implies, or substitutes for that licence. See
https://open-meteo.com/en/docs and https://github.com/open-meteo/open-meteo.

Documented policy choices
-------------------------
* Inputs are validated before any request: coordinates must be finite numbers
  inside ``-90..90`` / ``-180..180`` and ``days`` must be an ``int`` in
  ``1..7``. ``bool`` is rejected for all three. Rejection raises
  :class:`WeatherServiceError`, which subclasses :class:`ValueError`, so
  ``pytest.raises(ValueError)`` catches both input and upstream problems.
* The request URL is assembled from fixed key/value pairs with
  :func:`urllib.parse.urlencode`; no API key, token, or secret is ever added.
* Transport is an injectable seam (``http_get``). Unit tests inject a fake
  getter, so no test performs a real network request. The default transport is
  :func:`urllib.request.urlopen` with a caller-supplied timeout.
* Every transport problem (HTTP status, URL/DNS failure, timeout, generic
  ``OSError``) and every response problem (malformed JSON, non-object payload,
  missing/blank ``timezone``, missing ``current``/``daily`` objects, non-numeric
  current values, missing/misaligned daily arrays) is re-raised as
  :class:`WeatherServiceError` with the offending field named.
* ``location`` echoes the *requested* latitude/longitude (validated inputs keep
  output stable) and carries upstream ``elevation`` when present.
* Daily entries keep the upstream chronological order; no re-sorting is applied.
* ``precipitation_probability`` is the only field allowed to be ``None``
  (Open-Meteo omits precipitation probability for some regions). Every other
  emitted value is a real number, string, or list.
* Unit labels come from the upstream ``current_units`` / ``daily_units`` objects
  and are required for every requested field.
* Disposable smoke artefact: no server, CLI, cache, retry, scheduling, or
  wiring into the product.
"""

from __future__ import annotations

import json
import math
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

DEFAULT_BASE_URL = "https://api.open-meteo.com/v1/forecast"
CURRENT_FIELDS = ("temperature_2m", "weather_code", "wind_speed_10m")
DAILY_FIELDS = (
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_probability_max",
)

MIN_LATITUDE = -90.0
MAX_LATITUDE = 90.0
MIN_LONGITUDE = -180.0
MAX_LONGITUDE = 180.0
MIN_DAYS = 1
MAX_DAYS = 7
DEFAULT_DAYS = 3
DEFAULT_TIMEOUT_SECONDS = 5.0

ATTRIBUTION = (
    "Weather data (c) Open-Meteo, licensed CC BY 4.0; free for non-commercial use "
    "with attribution, commercial use requires an Open-Meteo commercial licence."
)


class WeatherServiceError(ValueError):
    """Raised for invalid inputs and for every upstream request/response failure."""


def _urlopen_get(url: str, timeout: float) -> bytes:
    """Fetch *url* with the standard library and return the raw response body."""
    request = urllib.request.Request(url, headers={"User-Agent": "workflow-smoke/1.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body: bytes = response.read()
    return body


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise WeatherServiceError(f"{field} must be a number, got {value!r}")
    number = float(value)
    if not math.isfinite(number):
        raise WeatherServiceError(f"{field} must be finite, got {value!r}")
    return number


class WeatherService:
    """Synchronous, keyless Open-Meteo Forecast API client with normalised output."""

    def __init__(
        self,
        *,
        http_get: Callable[[str], bytes] | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        base_url: str = DEFAULT_BASE_URL,
    ) -> None:
        self._timeout = _number(timeout, "timeout")
        if self._timeout <= 0:
            raise WeatherServiceError(f"timeout must be positive, got {timeout!r}")
        self._base_url = base_url
        self._http_get = http_get

    def get_forecast(
        self,
        latitude: float,
        longitude: float,
        days: int = DEFAULT_DAYS,
    ) -> dict[str, Any]:
        """Return a normalised forecast dict for *latitude*/*longitude* over *days* days.

        The result is JSON-safe with ``location``, ``timezone``, ``units``,
        ``current`` (``temperature``, ``weather_code``, ``wind_speed``),
        ``daily`` (``days`` entries of ``date``, ``temperature_min``,
        ``temperature_max``, ``precipitation_probability``) and ``attribution``.
        """
        self._validate(latitude, longitude, days)
        body = self._request(self.build_request_url(latitude, longitude, days))
        return self._normalize(self._decode_json(body), latitude, longitude, days)

    def build_request_url(self, latitude: float, longitude: float, days: int) -> str:
        """Return the fully escaped request URL for the validated arguments."""
        self._validate(latitude, longitude, days)
        params = [
            ("latitude", repr(float(latitude))),
            ("longitude", repr(float(longitude))),
            ("current", ",".join(CURRENT_FIELDS)),
            ("daily", ",".join(DAILY_FIELDS)),
            ("timezone", "auto"),
            ("forecast_days", str(days)),
        ]
        return f"{self._base_url}?{urllib.parse.urlencode(params)}"

    @staticmethod
    def _validate(latitude: Any, longitude: Any, days: Any) -> None:
        WeatherService._validate_coordinate(latitude, "latitude", MIN_LATITUDE, MAX_LATITUDE)
        WeatherService._validate_coordinate(longitude, "longitude", MIN_LONGITUDE, MAX_LONGITUDE)
        if isinstance(days, bool) or not isinstance(days, int):
            raise WeatherServiceError(f"days must be an int in {MIN_DAYS}..{MAX_DAYS}, got {days!r}")
        if not MIN_DAYS <= days <= MAX_DAYS:
            raise WeatherServiceError(f"days must be in {MIN_DAYS}..{MAX_DAYS}, got {days!r}")

    @staticmethod
    def _validate_coordinate(value: Any, name: str, low: float, high: float) -> None:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise WeatherServiceError(
                f"{name} must be a finite number between {low:g} and {high:g}, got {value!r}"
            )
        if not low <= float(value) <= high:
            raise WeatherServiceError(
                f"{name} must be between {low:g} and {high:g}, got {value!r}"
            )

    def _request(self, url: str) -> bytes:
        """Fetch *url* through the injected getter, mapping failures to domain errors."""
        getter = self._http_get if self._http_get is not None else _urlopen_get
        try:
            if self._http_get is None:
                body = getter(url, self._timeout)  # type: ignore[call-arg]
            else:
                body = getter(url)
        except urllib.error.HTTPError as exc:
            raise WeatherServiceError(f"upstream HTTP {exc.code} for {url}") from exc
        except urllib.error.URLError as exc:
            raise WeatherServiceError(f"upstream request failed for {url}: {exc.reason}") from exc
        except (TimeoutError, OSError) as exc:
            raise WeatherServiceError(f"upstream request failed for {url}: {exc}") from exc
        except ValueError as exc:
            raise WeatherServiceError(f"invalid request URL {url!r}: {exc}") from exc
        if not isinstance(body, (bytes, bytearray, str)):
            raise WeatherServiceError("upstream response body must be bytes or str")
        return body

    @staticmethod
    def _decode_json(body: bytes | bytearray | str) -> dict[str, Any]:
        """Parse *body* as a JSON object, mapping malformed input to a domain error."""
        try:
            payload = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError, TypeError, RecursionError) as exc:
            raise WeatherServiceError("upstream response is malformed JSON") from exc
        if not isinstance(payload, dict):
            raise WeatherServiceError("upstream response must be a JSON object")
        return payload

    def _normalize(
        self,
        payload: dict[str, Any],
        latitude: float,
        longitude: float,
        days: int,
    ) -> dict[str, Any]:
        location: dict[str, Any] = {"latitude": latitude, "longitude": longitude}
        elevation = payload.get("elevation")
        location["elevation"] = None if elevation is None else _number(elevation, "elevation")
        timezone = payload.get("timezone")
        if not isinstance(timezone, str) or not timezone.strip():
            raise WeatherServiceError(f"upstream response field timezone is missing: {timezone!r}")
        units = self._units(payload)
        return {
            "location": location,
            "timezone": timezone,
            "units": units,
            "current": self._current(payload, units),
            "daily": self._daily(payload, days, units),
            "attribution": ATTRIBUTION,
        }

    @staticmethod
    def _units(payload: dict[str, Any]) -> dict[str, str]:
        units: dict[str, str] = {}
        for section, fields in (
            ("current_units", CURRENT_FIELDS),
            ("daily_units", DAILY_FIELDS),
        ):
            raw = payload.get(section)
            if not isinstance(raw, dict):
                raise WeatherServiceError(f"upstream response field {section} is missing")
            for field in fields:
                label = raw.get(field)
                if not isinstance(label, str) or not label.strip():
                    raise WeatherServiceError(
                        f"upstream response field {section}.{field} is missing: {label!r}"
                    )
                units[field] = label
        return units

    @staticmethod
    def _current(payload: dict[str, Any], units: dict[str, str]) -> dict[str, Any]:
        raw = payload.get("current")
        if not isinstance(raw, dict):
            raise WeatherServiceError("upstream response field current is missing")
        current: dict[str, Any] = {}
        for key, field in (
            ("temperature", "temperature_2m"),
            ("weather_code", "weather_code"),
            ("wind_speed", "wind_speed_10m"),
        ):
            current[key] = _number(raw.get(field), f"current.{field}")
        current["units"] = {
            "temperature": units["temperature_2m"],
            "weather_code": "unitless",
            "wind_speed": units["wind_speed_10m"],
        }
        return current

    @staticmethod
    def _daily(payload: dict[str, Any], days: int, units: dict[str, str]) -> list[dict[str, Any]]:
        raw = payload.get("daily")
        if not isinstance(raw, dict):
            raise WeatherServiceError("upstream response field daily is missing")
        dates = raw.get("time")
        if not isinstance(dates, list):
            raise WeatherServiceError(f"upstream response field daily.time must be a list: {dates!r}")
        if len(dates) != days:
            raise WeatherServiceError(
                f"upstream response field daily.time has {len(dates)} entries, expected {days}"
            )
        series: dict[str, list[Any]] = {}
        for field in DAILY_FIELDS:
            values = raw.get(field)
            if not isinstance(values, list):
                raise WeatherServiceError(
                    f"upstream response field daily.{field} must be a list: {values!r}"
                )
            if len(values) != days:
                raise WeatherServiceError(
                    f"upstream response field daily.{field} has {len(values)} entries, "
                    f"expected {days}"
                )
            series[field] = values
        daily: list[dict[str, Any]] = []
        for index, day in enumerate(dates):
            if not isinstance(day, str) or not day.strip():
                raise WeatherServiceError(f"upstream response field daily.time[{index}] is invalid")
            precipitation = series["precipitation_probability_max"][index]
            daily.append(
                {
                    "date": day,
                    "temperature_min": _number(
                        series["temperature_2m_min"][index], f"daily.temperature_2m_min[{index}]"
                    ),
                    "temperature_max": _number(
                        series["temperature_2m_max"][index], f"daily.temperature_2m_max[{index}]"
                    ),
                    "precipitation_probability": (
                        None
                        if precipitation is None
                        else _number(
                            precipitation,
                            f"daily.precipitation_probability_max[{index}]",
                        )
                    ),
                }
            )
        return daily


__all__ = ["ATTRIBUTION", "WeatherService", "WeatherServiceError"]
