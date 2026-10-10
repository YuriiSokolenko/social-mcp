"""Focused tests for the Open-Meteo WeatherService smoke artefact (issue #730).

All transport is faked: these tests never open a socket.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest

MODULE_PATH = (
    Path(__file__).parents[2]
    / "examples"
    / "workflow-smoke"
    / "pack-20261010"
    / "weather"
    / "weather.py"
)

SPEC = spec_from_file_location("weather", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
weather = module_from_spec(SPEC)
SPEC.loader.exec_module(weather)

WeatherService = weather.WeatherService
WeatherServiceError = weather.WeatherServiceError
BERLIN = (52.52, 13.41)


class FakeGet:
    """Record requested URLs and reply with a canned body, or raise."""

    def __init__(self, body: "bytes | str", error: Exception | None = None) -> None:
        self.body = body
        self.error = error
        self.urls: list[str] = []

    def __call__(self, url: str) -> "bytes | str":
        self.urls.append(url)
        if self.error is not None:
            raise self.error
        return self.body


def _payload(days: int = 3, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "latitude": 52.52,
        "longitude": 13.41,
        "timezone": "Europe/Berlin",
        "timezone_abbreviation": "CET",
        "elevation": 34.0,
        "current": {
            "time": "2026-10-10T12:00",
            "temperature_2m": 11.4,
            "weather_code": 3,
            "wind_speed_10m": 7.2,
        },
        "current_units": {
            "time": "iso8601",
            "temperature_2m": "°C",
            "weather_code": "wmo code",
            "wind_speed_10m": "km/h",
        },
        "daily": {
            "time": [f"2026-10-{10 + index:02d}" for index in range(days)],
            "temperature_2m_max": [round(14.1 + index, 1) for index in range(days)],
            "temperature_2m_min": [round(5.1 + index, 1) for index in range(days)],
            "precipitation_probability_max": [10 * (index + 1) for index in range(days)],
        },
        "daily_units": {
            "time": "iso8601",
            "temperature_2m_max": "°C",
            "temperature_2m_min": "°C",
            "precipitation_probability_max": "%",
        },
    }
    body.update(overrides)
    return body


def _service(payload: Any = None, **kwargs: Any) -> tuple[WeatherService, FakeGet]:
    body = json.dumps(_payload() if payload is None else payload)
    fake = FakeGet(body, kwargs.pop("error", None))
    return WeatherService(http_get=fake, **kwargs), fake


def test_default_forecast_schema() -> None:
    service, fake = _service()
    result = service.get_forecast(*BERLIN)

    assert result["latitude"] == pytest.approx(52.52)
    assert result["longitude"] == pytest.approx(13.41)
    assert result["timezone"] == "Europe/Berlin"
    assert result["timezone_abbreviation"] == "CET"
    assert result["elevation_m"] == pytest.approx(34.0)
    assert result["units"] == {
        "temperature": "°C",
        "wind_speed": "km/h",
        "precipitation_probability": "%",
    }
    assert result["current"] == {
        "temperature_c": pytest.approx(11.4),
        "weather_code": 3,
        "wind_speed_kmh": pytest.approx(7.2),
    }
    assert len(result["daily"]) == 3
    assert len(fake.urls) == 1


@pytest.mark.parametrize("days", [1, 3, 7])
def test_daily_entries_are_normalized(days: int) -> None:
    service, fake = _service(_payload(days=days))
    result = service.get_forecast(*BERLIN, days=days)

    assert len(result["daily"]) == days
    for entry in result["daily"]:
        assert set(entry) == {
            "date",
            "temperature_max_c",
            "temperature_min_c",
            "precipitation_probability_pct",
        }
        assert entry["date"].startswith("2026-10-")
    assert result["daily"][0]["temperature_max_c"] == pytest.approx(14.1)
    assert result["daily"][0]["temperature_min_c"] == pytest.approx(5.1)
    assert result["daily"][0]["precipitation_probability_pct"] == pytest.approx(10.0)
    assert result["daily"][-1]["temperature_max_c"] == pytest.approx(14.1 + days - 1)
    assert f"forecast_days={days}" in fake.urls[0]


def test_url_is_https_open_meteo_with_expected_params() -> None:
    service, fake = _service(_payload(days=5))
    service.get_forecast(52.52, 13.41, days=5)

    parsed = urlparse(fake.urls[0])
    assert parsed.scheme == "https"
    assert parsed.netloc == "api.open-meteo.com"
    assert parsed.path == "/v1/forecast"
    query = {key: value[0] for key, value in parse_qs(parsed.query).items()}
    assert query["current"] == "temperature_2m,weather_code,wind_speed_10m"
    assert query["daily"] == (
        "temperature_2m_max,temperature_2m_min,precipitation_probability_max"
    )
    assert query["timezone"] == "auto"
    assert query["forecast_days"] == "5"
    assert query["latitude"] == "52.520000"
    assert query["longitude"] == "13.410000"
    assert not any("key" in name.lower() for name in query)


def test_build_request_url_uses_urlencode() -> None:
    url = weather.build_request_url(35.68, 139.69, 2)
    assert url.startswith("https://api.open-meteo.com/v1/forecast?")
    assert "timezone=auto" in url
    assert "forecast_days=2" in url
    assert "latitude=35.680000" in url


@pytest.mark.parametrize(
    ("latitude", "longitude", "days"),
    [
        (float("nan"), 13.41, 3),
        (float("inf"), 13.41, 3),
        (52.52, float("nan"), 3),
        (52.52, float("-inf"), 3),
        (90.1, 13.41, 3),
        (-91.0, 13.41, 3),
        (52.52, 180.1, 3),
        (52.52, -181.0, 3),
        (52.52, 13.41, 0),
        (52.52, 13.41, 8),
        (52.52, 13.41, True),
        (52.52, 13.41, "3"),
        (52.52, 13.41, 3.0),
        ("52.52", 13.41, 3),
        (None, 13.41, 3),
    ],
)
def test_invalid_inputs_rejected_before_transport(
    latitude: Any, longitude: Any, days: Any
) -> None:
    service, fake = _service()
    with pytest.raises(ValueError):
        service.get_forecast(latitude, longitude, days)
    assert fake.urls == []


@pytest.mark.parametrize(
    ("latitude", "longitude", "days"),
    [(90.0, -180.0, 1), (-90.0, 180.0, 7), (0, 0, 1), (52, 13, 3)],
)
def test_boundary_values_accepted(
    latitude: float, longitude: float, days: int
) -> None:
    service, fake = _service(_payload(days=days))
    result = service.get_forecast(latitude, longitude, days)
    assert result["latitude"] == pytest.approx(float(latitude))
    assert result["longitude"] == pytest.approx(float(longitude))
    assert len(result["daily"]) == days
    assert len(fake.urls) == 1


def test_transport_errors_are_wrapped() -> None:
    service, _ = _service(
        error=urllib.error.URLError("boom"),
    )
    with pytest.raises(WeatherServiceError):
        service.get_forecast(*BERLIN)

def test_http_error_is_wrapped() -> None:
    error = urllib.error.HTTPError(
        "https://api.open-meteo.com/v1/forecast", 503, "unavailable", {}, None
    )
    service, _ = _service(error=error)
    with pytest.raises(WeatherServiceError):
        service.get_forecast(*BERLIN)


@pytest.mark.parametrize("body", [b"<html>nope", "{", b"[]", "null", 123])
def test_malformed_bodies_are_rejected(body: Any) -> None:
    fake = FakeGet(body)
    service = WeatherService(http_get=fake)
    with pytest.raises(WeatherServiceError):
        service.get_forecast(*BERLIN)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p["daily"].pop("precipitation_probability_max"),
        lambda p: p["daily"].__setitem__("time", ["2026-10-10", "2026-10-11"]),
        lambda p: p["current"].pop("weather_code"),
        lambda p: p.pop("timezone"),
        lambda p: p.pop("daily"),
        lambda p: p.pop("current_units"),
        lambda p: p["daily"].__setitem__("temperature_2m_min", "cold"),
        lambda p: p["daily"].__setitem__("time", ["yesterday", "2026-10-11", "2026-10-12"]),
    ],
)
def test_schema_failures_are_rejected(mutate: Any) -> None:
    payload = _payload()
    mutate(payload)
    service, _ = _service(payload)
    with pytest.raises(WeatherServiceError):
        service.get_forecast(*BERLIN)


def test_null_precipitation_probability_is_preserved() -> None:
    payload = _payload()
    payload["daily"]["precipitation_probability_max"] = [None, None, None]
    service, _ = _service(payload)
    result = service.get_forecast(*BERLIN)
    assert [entry["precipitation_probability_pct"] for entry in result["daily"]] == [
        None,
        None,
        None,
    ]


def test_default_transport_path_uses_urlopen_with_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}
    body = json.dumps(_payload(days=2)).encode("utf-8")

    class Response:
        def read(self) -> bytes:
            return body

        def __enter__(self) -> "Response":
            return self

        def __exit__(self, *exc: Any) -> None:
            return None

    def fake_urlopen(request: Any, timeout: float | None = None) -> Response:
        captured["url"] = request.full_url
        captured["headers"] = dict(request.headers)
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    result = WeatherService(timeout=4.5).get_forecast(*BERLIN, days=2)

    assert captured["url"].startswith("https://api.open-meteo.com/v1/forecast?")
    assert captured["timeout"] == 4.5
    assert captured["headers"].get("User-agent") == weather.USER_AGENT
    assert len(result["daily"]) == 2


def test_default_transport_wraps_socket_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def explode(request: Any, timeout: float | None = None) -> Any:
        raise TimeoutError("timed out")

    monkeypatch.setattr(urllib.request, "urlopen", explode)
    with pytest.raises(WeatherServiceError):
        WeatherService().get_forecast(*BERLIN)


def test_constructor_validates_configuration() -> None:
    with pytest.raises(ValueError):
        WeatherService(timeout=0)
    with pytest.raises(ValueError):
        WeatherService(timeout=float("nan"))
    with pytest.raises(ValueError):
        WeatherService(base_url="http://insecure.example/v1/forecast")


def test_identical_payload_is_deterministic() -> None:
    first, _ = _service()
    second, _ = _service()
    left = first.get_forecast(*BERLIN, days=3)
    right = second.get_forecast(*BERLIN, days=3)
    assert left == right
    assert json.dumps(left, sort_keys=True) == json.dumps(right, sort_keys=True)
