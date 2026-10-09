"""Synchronous weather forecast service backed by the Open-Meteo Forecast API.

Open-Meteo publishes its data under the Creative Commons Attribution 4.0
International licence (CC BY 4.0), so consumers must attribute Open-Meteo and
the upstream meteorological sources. The hosted API needs no API key, but that
free tier covers **non-commercial use only**: it is not licensed for commercial
use, and commercial or production traffic requires a paid plan. See
https://open-meteo.com/en/docs and https://github.com/open-meteo/open-meteo.

Only the Python standard library is used. Transport is an injected callable so
request building and response parsing can be tested deterministically without
opening a network socket.
"""

import json
import math
from collections.abc import Callable
from urllib.error import HTTPError
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import urlopen

ENDPOINT = "https://api.open-meteo.com/v1/forecast"
DEFAULT_TIMEOUT = 10.0
MIN_DAYS = 1
MAX_DAYS = 7

CURRENT_FIELDS = ("temperature_2m", "weather_code", "wind_speed_10m")
DAILY_FIELDS = (
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_probability_max",
)
UNITS = {"temperature_c": "celsius", "wind_speed": "km/h"}


class WeatherServiceError(RuntimeError):
    """Raised when the upstream request, decoding, or payload shape fails."""


class WeatherService:
    """Read-only wrapper around the Open-Meteo Forecast API.

    ``http_get`` is the transport seam: it receives a built request URL and
    returns raw ``bytes`` or an already decoded ``str``. Callers leave it as
    ``None`` to use :func:`urllib.request.urlopen` with ``timeout``; tests
    inject a canned payload so no real request is ever attempted.
    """

    def __init__(
        self,
        http_get: Callable[[str], "bytes | str"] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self.http_get = http_get
        self.timeout = timeout

    @staticmethod
    def build_params(latitude: float, longitude: float, days: int = 3) -> dict[str, str]:
        """Build the Open-Meteo query parameters for one forecast request."""
        return {
            "latitude": f"{latitude:.6f}",
            "longitude": f"{longitude:.6f}",
            "current": ",".join(CURRENT_FIELDS),
            "daily": ",".join(DAILY_FIELDS),
            "timezone": "auto",
            "forecast_days": str(days),
        }

    @classmethod
    def build_url(cls, latitude: float, longitude: float, days: int = 3) -> str:
        """Build a safe request URL whose query string uses ``urlencode``."""
        return f"{ENDPOINT}?{urlencode(cls.build_params(latitude, longitude, days))}"

    def get_forecast(self, latitude: float, longitude: float, days: int = 3) -> dict[str, object]:
        """Fetch and normalise a forecast for ``(latitude, longitude)``.

        The result has ``location``, ``timezone``, ``units``, ``current`` and
        ``daily`` keys, with exactly ``days`` daily entries. ``ValueError``
        reports invalid arguments; :class:`WeatherServiceError` reports
        transport, decoding, and schema failures.
        """
        self._validate(latitude, longitude, days)
        body = self._fetch(self.build_url(latitude, longitude, days))
        return self._normalize(self._decode(body), latitude, longitude, days)

    def _fetch(self, url: str) -> str:
        try:
            if self.http_get is not None:
                body: bytes | str = self.http_get(url)
            else:
                with urlopen(url, timeout=self.timeout) as response:
                    body = response.read()
        except HTTPError as error:
            raise WeatherServiceError(f"Open-Meteo returned HTTP error {error.code}") from error
        except URLError as error:
            raise WeatherServiceError(f"Open-Meteo request failed: {error}") from error
        except OSError as error:  # urllib also reports socket timeouts here
            raise WeatherServiceError(f"Open-Meteo transport failed: {error}") from error
        except (ValueError, UnicodeDecodeError) as error:
            raise WeatherServiceError(f"Open-Meteo response was unusable: {error}") from error
        if isinstance(body, bytes):
            try:
                return body.decode("utf-8")
            except UnicodeDecodeError as error:
                raise WeatherServiceError("Open-Meteo response was not valid UTF-8") from error
        return str(body)

    @staticmethod
    def _decode(body: str) -> object:
        try:
            return json.loads(body)
        except ValueError as error:  # json.JSONDecodeError is a ValueError
            raise WeatherServiceError(f"Open-Meteo response was unusable: {error}") from error

    def _normalize(
        self, payload: object, latitude: float, longitude: float, days: int
    ) -> dict[str, object]:
        data = self._require_object(payload, "payload")
        return {
            "location": {"latitude": latitude, "longitude": longitude},
            "timezone": self._require_text(data, "timezone", "payload"),
            "units": dict(UNITS),
            "current": self._normalize_current(
                self._require_object(data.get("current"), "current")
            ),
            "daily": self._normalize_daily(self._require_object(data.get("daily"), "daily"), days),
        }

    def _normalize_current(self, current: dict[str, object]) -> dict[str, object]:
        return {
            "temperature": self._require_number(current, "temperature_2m", "current"),
            "weather_code": self._require_number(current, "weather_code", "current"),
            "wind_speed": self._require_number(current, "wind_speed_10m", "current"),
        }

    def _normalize_daily(self, daily: dict[str, object], days: int) -> list[dict[str, object]]:
        columns = {field: self._aligned_array(daily, field, days) for field in DAILY_FIELDS}
        times = self._aligned_array(daily, "time", days)
        return [
            {
                "date": times[index],
                "temperature_max": columns["temperature_2m_max"][index],
                "temperature_min": columns["temperature_2m_min"][index],
                "precipitation_probability": columns["precipitation_probability_max"][index],
            }
            for index in range(days)
        ]

    @staticmethod
    def _require_object(value: object, name: str) -> dict[str, object]:
        if not isinstance(value, dict):
            raise WeatherServiceError(f"Open-Meteo {name} must be a JSON object")
        return value

    @staticmethod
    def _require_text(mapping: dict[str, object], key: str, name: str) -> str:
        value = mapping.get(key)
        if not isinstance(value, str) or not value:
            raise WeatherServiceError(f"Open-Meteo response is missing {name}.{key}")
        return value

    @staticmethod
    def _require_number(mapping: dict[str, object], key: str, name: str) -> float:
        value = mapping.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise WeatherServiceError(f"Open-Meteo {name} is missing numeric {key!r}")
        return float(value)

    @staticmethod
    def _aligned_array(daily: dict[str, object], key: str, expected: int) -> list[object]:
        value = daily.get(key)
        if not isinstance(value, list) or not value:
            raise WeatherServiceError(f"Open-Meteo daily is missing a non-empty {key!r} array")
        if len(value) != expected:
            raise WeatherServiceError(
                f"Open-Meteo daily {key!r} has {len(value)} entries, expected {expected}"
            )
        return value

    @staticmethod
    def _validate(latitude: object, longitude: object, days: object) -> None:
        WeatherService._check_coordinate("latitude", latitude)
        WeatherService._check_coordinate("longitude", longitude)
        if isinstance(days, bool) or not isinstance(days, int):
            raise ValueError(f"days must be an int in {MIN_DAYS}..{MAX_DAYS}")
        if days < MIN_DAYS or days > MAX_DAYS:
            raise ValueError(f"days must be between {MIN_DAYS} and {MAX_DAYS}")

    @staticmethod
    def _check_coordinate(name: str, value: object) -> None:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{name} must be a number")
        if not math.isfinite(value):
            raise ValueError(f"{name} must be finite")
        limit = 90 if name == "latitude" else 180
        if value < -limit or value > limit:
            raise ValueError(f"{name} must be between -{limit} and {limit}")
