"""Focused coverage for the disposable Open-Meteo weather smoke service.

Every test injects a fake transport, so no test can reach the network.
"""

import importlib.util
import json
import urllib.error
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

_MODULE_PATH = (
    Path(__file__).resolve().parents[2]
    / "examples"
    / "workflow-smoke"
    / "weather"
    / "weather.py"
)

_spec = importlib.util.spec_from_file_location("weather_smoke_app", _MODULE_PATH)
assert _spec is not None and _spec.loader is not None
_weather = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_weather)

WeatherService = _weather.WeatherService
WeatherServiceError = _weather.WeatherServiceError


class _FakeTransport:
    """Return a canned response body and record every requested URL."""

    def __init__(self, body: bytes) -> None:
        self._body = body
        self.urls: list[str] = []

    def __call__(self, url: str) -> bytes:
        self.urls.append(url)
        return self._body


class _FailingTransport:
    """Raise a canned exception, mirroring a transport or JSON failure."""

    def __init__(self, error: BaseException) -> None:
        self._error = error
        self.urls: list[str] = []

    def __call__(self, url: str) -> bytes:
        self.urls.append(url)
        raise self._error


def _payload(days: int = 3, **overrides: Any) -> dict[str, Any]:
    """Return a deterministic Open-Meteo response for ``days`` days."""
    payload: dict[str, Any] = {
        "latitude": 52.52,
        "longitude": 13.41,
        "timezone": "Europe/Berlin",
        "current_units": {"temperature_2m": "°C", "wind_speed_10m": "km/h"},
        "current": {"temperature_2m": 12.5, "weather_code": 3, "wind_speed_10m": 17.2},
        "daily_units": {
            "temperature_2m_max": "°C",
            "temperature_2m_min": "°C",
            "precipitation_probability_max": "%",
        },
        "daily": {
            "time": [f"2026-01-{index + 1:02d}" for index in range(days)],
            "temperature_2m_max": [9.5 + index for index in range(days)],
            "temperature_2m_min": [4.5 + index for index in range(days)],
            "precipitation_probability_max": [80 if index != 1 else None for index in range(days)],
        },
    }
    payload.update(overrides)
    return payload


def _service(payload: Any) -> tuple[Any, _FakeTransport]:
    """Return a service wired to an injected fake transport."""
    transport = _FakeTransport(_bytes_body(payload))
    return WeatherService(transport), transport


def _bytes_body(payload: Any) -> bytes:
    """Encode a payload as the bytes a real transport would return."""
    if isinstance(payload, (bytes, bytearray)):
        return bytes(payload)
    return json.dumps(payload).encode()


def _query(url: str) -> dict[str, list[str]]:
    """Return the decoded query parameters of ``url``."""
    return parse_qs(urlsplit(url).query)


def test_validation_rejects_non_finite_and_out_of_range_coordinates() -> None:
    service = WeatherService(_FakeTransport(b"{}"))
    for bad in [float("nan"), float("inf"), -float("inf"), 91.0, -95.0]:
        with pytest.raises(ValueError):
            service.get_forecast(bad, 13.41)
    with pytest.raises(ValueError):
        service.get_forecast(52.52, 181.0)
    with pytest.raises(ValueError):
        service.get_forecast(52.52, -200.0)


@pytest.mark.parametrize("days", [0, 8, 1.5, "3", True, None])
def test_validation_rejects_unusable_days(days: Any) -> None:
    service = WeatherService(_FakeTransport(b"{}"))
    with pytest.raises(ValueError):
        service.get_forecast(52.52, 13.41, days)  # type: ignore[arg-type]


@pytest.mark.parametrize("days", [1, 7])
def test_validation_accepts_the_documented_extremes(days: int) -> None:
    service, transport = _service(_payload(days))

    result = service.get_forecast(-90.0, -180.0, days)

    assert len(result["daily"]) == days
    assert _query(transport.urls[0])["forecast_days"] == [str(days)]


def test_url_uses_the_documented_endpoint_and_parameters() -> None:
    service, transport = _service(_payload())

    service.get_forecast(52.52, 13.41)

    split = urlsplit(transport.urls[0])
    assert f"{split.scheme}://{split.netloc}{split.path}" == _weather.ENDPOINT
    query = _query(transport.urls[0])
    assert query["latitude"] == ["52.52"]
    assert query["longitude"] == ["13.41"]
    assert query["current"] == [_weather.CURRENT_FIELDS]
    assert query["daily"] == [_weather.DAILY_FIELDS]
    assert query["timezone"] == ["auto"]
    assert query["forecast_days"] == ["3"]


def test_transport_is_called_once_with_the_built_url() -> None:
    service, transport = _service(_payload(2))

    service.get_forecast(52.52, 13.41, 2)

    assert transport.urls == [_weather.WeatherService._build_url(52.52, 13.41, 2)]


def test_normalized_shape_location_and_units() -> None:
    service, _transport = _service(_payload())

    result = service.get_forecast(52.52, 13.41)

    assert set(result) == {"location", "timezone", "units", "current", "daily"}
    assert result["location"] == {"latitude": 52.52, "longitude": 13.41}
    assert result["timezone"] == "Europe/Berlin"
    assert result["units"] == {
        "temperature": "°C",
        "wind_speed": "km/h",
        "precipitation_probability": "%",
    }
    assert result["current"] == {
        "temperature": 12.5,
        "weather_code": 3,
        "wind_speed": 17.2,
    }
    assert isinstance(result["current"]["temperature"], float)
    assert isinstance(result["current"]["weather_code"], int)


def test_daily_entries_are_normalized_per_day() -> None:
    service, _transport = _service(_payload())

    daily = service.get_forecast(52.52, 13.41)["daily"]

    assert len(daily) == 3
    assert daily[0] == {
        "date": "2026-01-01",
        "temperature_min": 4.5,
        "temperature_max": 9.5,
        "precipitation_probability": 80,
    }
    # Open-Meteo omits a probability it cannot estimate; that stays ``None``.
    assert daily[1]["precipitation_probability"] is None
    assert daily[2]["temperature_max"] == 11.5


@pytest.mark.parametrize(
    "error",
    [
        urllib.error.HTTPError("https://example.invalid", 500, "boom", None, None),
        urllib.error.URLError("unreachable"),
        OSError("timed out"),
    ],
)
def test_transport_failures_become_service_errors(error: BaseException) -> None:
    service = WeatherService(_FailingTransport(error))

    with pytest.raises(WeatherServiceError):
        service.get_forecast(52.52, 13.41)


def test_malformed_json_becomes_service_error() -> None:
    service = WeatherService(_FakeTransport(b"not json"))

    with pytest.raises(WeatherServiceError):
        service.get_forecast(52.52, 13.41)


def test_missing_required_objects_become_service_error() -> None:
    service = WeatherService(_FakeTransport(json.dumps({"timezone": "Europe/Berlin"}).encode()))

    with pytest.raises(WeatherServiceError):
        service.get_forecast(52.52, 13.41)


def test_missing_or_misaligned_daily_arrays_become_service_error() -> None:
    missing = _payload()
    del missing["daily"]["temperature_2m_min"]
    service, _transport = _service(missing)
    with pytest.raises(WeatherServiceError):
        service.get_forecast(52.52, 13.41)

    misaligned = _payload()
    misaligned["daily"]["temperature_2m_max"] = [9.5]
    service, _transport = _service(misaligned)
    with pytest.raises(WeatherServiceError):
        service.get_forecast(52.52, 13.41)


def test_day_count_mismatch_becomes_service_error() -> None:
    service, _transport = _service(_payload(2))

    with pytest.raises(WeatherServiceError):
        service.get_forecast(52.52, 13.41, 3)
