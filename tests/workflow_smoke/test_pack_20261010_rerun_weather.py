"""Focused tests for the disposable Open-Meteo weather smoke (issue #752).

All transport is injected; no test performs a network request.
"""

from __future__ import annotations

import io
import json
import math
import urllib.error
import urllib.request
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

MODULE_PATH = (
    Path(__file__).parents[2]
    / "examples"
    / "workflow-smoke"
    / "pack-20261010-rerun"
    / "weather"
    / "weather.py"
)

SPEC = spec_from_file_location("weather", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
weather = module_from_spec(SPEC)
SPEC.loader.exec_module(weather)

get_forecast = weather.get_forecast
build_request_url = weather.build_request_url
WeatherServiceError = weather.WeatherServiceError


def _payload(days: int = 3, **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "latitude": 52.52,
        "longitude": 13.41,
        "timezone": "Europe/Berlin",
        "timezone_abbreviation": "GMT+2",
        "elevation": 34.0,
        "current": {
            "time": "2026-10-10T12:00",
            "temperature_2m": 21.3,
            "weather_code": 3,
            "wind_speed_10m": 11.2,
        },
        "current_units": {
            "time": "iso8601",
            "temperature_2m": "°C",
            "weather_code": "unit",
            "wind_speed_10m": "km/h",
        },
        "daily": {
            "time": [f"2026-10-{10 + index:02d}" for index in range(days)],
            "temperature_2m_max": [18.0 + index for index in range(days)],
            "temperature_2m_min": [9.0 + index for index in range(days)],
            "precipitation_probability_max": [10 * index for index in range(days)],
        },
        "daily_units": {
            "time": "iso8601",
            "temperature_2m_max": "°C",
            "temperature_2m_min": "°C",
            "precipitation_probability_max": "%",
        },
    }
    payload.update(overrides)
    return payload


class _Fetcher:
    """Deterministic transport stub that records every requested URL."""

    def __init__(self, body: Any = None, *, error: Exception | None = None) -> None:
        self.body = body
        self.error = error
        self.urls: list[str] = []

    def __call__(self, url: str) -> bytes:
        self.urls.append(url)
        if self.error is not None:
            raise self.error
        if isinstance(self.body, (bytes, bytearray)):
            return bytes(self.body)
        if isinstance(self.body, str):
            return self.body.encode("utf-8")
        return json.dumps(self.body).encode("utf-8")


def _json_fetcher(payload: Any) -> _Fetcher:
    return _Fetcher(payload)


def _http_error(code: int = 500, reason: str = "Server Error") -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        "https://api.open-meteo.com/v1/forecast",
        code,
        reason,
        {},  # type: ignore[arg-type]
        io.BytesIO(b"{}"),
    )


@pytest.fixture(autouse=True)
def _forbid_real_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("tests must not perform real network requests")

    monkeypatch.setattr(urllib.request, "urlopen", _boom)


def test_normalizes_full_schema() -> None:
    result = get_forecast(52.52, 13.41, 3, fetch=_json_fetcher(_payload(days=3)))
    assert set(result) == {"location", "timezone", "units", "current", "daily", "days"}
    assert result["location"] == {"latitude": 52.52, "longitude": 13.41}
    assert result["timezone"] == "Europe/Berlin"
    assert result["units"] == {
        "temperature": "°C",
        "wind_speed": "km/h",
        "precipitation_probability": "%",
    }
    assert result["current"] == {"temperature": 21.3, "weather_code": 3, "wind_speed": 11.2}
    assert result["days"] == 3
    assert len(result["daily"]) == 3
    assert result["daily"][0] == {
        "date": "2026-10-10",
        "temperature_max": 18.0,
        "temperature_min": 9.0,
        "precipitation_probability": 0,
    }
    assert json.loads(json.dumps(result)) == result


def test_default_days_is_three() -> None:
    fetcher = _json_fetcher(_payload(days=3))
    result = get_forecast(52.52, 13.41, fetch=fetcher)
    assert len(result["daily"]) == 3
    assert result["days"] == 3
    assert parse_qs(urlsplit(fetcher.urls[0]).query)["forecast_days"] == ["3"]


@pytest.mark.parametrize("days", [1, 7])
def test_boundary_days(days: int) -> None:
    fetcher = _json_fetcher(_payload(days=days))
    result = get_forecast(52.52, 13.41, days, fetch=fetcher)
    assert len(result["daily"]) == days
    assert result["days"] == days


@pytest.mark.parametrize("lat,lon", [(90.0, -180.0), (-90.0, 180.0), (0.0, 0.0)])
def test_boundary_coordinates_are_accepted(lat: float, lon: float) -> None:
    result = get_forecast(lat, lon, 1, fetch=_json_fetcher(_payload(days=1)))
    assert result["location"] == {"latitude": lat, "longitude": lon}


def test_url_uses_https_endpoint_and_required_params() -> None:
    url = build_request_url(-33.86, 151.21, 5)
    parts = urlsplit(url)
    assert parts.scheme == "https"
    assert parts.netloc == "api.open-meteo.com"
    assert parts.path == "/v1/forecast"
    query = parse_qs(parts.query)
    assert query["current"] == ["temperature_2m,weather_code,wind_speed_10m"]
    assert query["daily"] == [
        "temperature_2m_max,temperature_2m_min,precipitation_probability_max"
    ]
    assert query["timezone"] == ["auto"]
    assert query["forecast_days"] == ["5"]
    assert float(query["latitude"][0]) == pytest.approx(-33.86)
    assert float(query["longitude"][0]) == pytest.approx(151.21)
    assert " " not in url


def test_default_fetcher_uses_urlopen_with_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    class _Response:
        def read(self) -> bytes:
            return json.dumps(_payload(days=1)).encode("utf-8")

        def __enter__(self) -> "_Response":
            return self

        def __exit__(self, *exc: Any) -> None:
            return None

    def _fake_urlopen(url: str, timeout: Any = None) -> _Response:
        seen["url"] = url
        seen["timeout"] = timeout
        return _Response()

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)
    result = weather._default_fetch("https://api.open-meteo.com/v1/forecast?x=1")
    assert seen["url"] == "https://api.open-meteo.com/v1/forecast?x=1"
    assert seen["timeout"] == weather.DEFAULT_TIMEOUT
    assert json.loads(result)["timezone"] == "Europe/Berlin"
