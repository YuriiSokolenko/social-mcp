"""Offline tests for the disposable Open-Meteo ``WeatherService`` example."""

import importlib.util
import json
import math
import urllib.error
import urllib.parse
from pathlib import Path

import pytest

_MODULE_PATH = (
    Path(__file__).resolve().parents[2] / "examples" / "workflow-smoke" / "weather" / "weather.py"
)
_spec = importlib.util.spec_from_file_location("smoke_weather", _MODULE_PATH)
assert _spec is not None and _spec.loader is not None
weather = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(weather)

LAT = 47.2692
LON = 9.1621


def make_payload(days: int = 3) -> dict:
    """Deterministic stand-in for one Open-Meteo /v1/forecast response."""
    return {
        "timezone": "Europe/Zurich",
        "current": {"temperature_2m": 12.5, "weather_code": 2, "wind_speed_10m": 7.4},
        "current_units": {"temperature_2m": "\u00b0C", "wind_speed_10m": "km/h"},
        "daily": {
            "time": [f"2026-01-{i + 1:02d}" for i in range(days)],
            "temperature_2m_max": [20.0 + i for i in range(days)],
            "temperature_2m_min": [10.0 - i for i in range(days)],
            "precipitation_probability_max": [10 * i for i in range(days)],
        },
        "daily_units": {
            "temperature_2m_max": "\u00b0C",
            "temperature_2m_min": "\u00b0C",
            "precipitation_probability_max": "%",
        },
    }


class FakeGet:
    """Injected transport: records request URLs, returns a canned payload."""

    def __init__(self, payload=None, error=None):
        self.payload = payload
        self.error = error
        self.urls: list[str] = []

    def __call__(self, url: str) -> dict:
        """Record the request, then answer with the canned or matching payload."""
        self.urls.append(url)
        if self.error is not None:
            raise self.error
        if self.payload is None:
            query = urllib.parse.parse_qs(url.split("?", 1)[1])
            return make_payload(int(query["forecast_days"][0]))
        return self.payload


def make_service(payload=None, error=None):
    getter = FakeGet(payload=payload, error=error)
    return weather.WeatherService(http_get=getter), getter


def test_rejects_non_finite_coordinates():
    service = weather.WeatherService(http_get=FakeGet())
    for bad in (math.nan, math.inf, -math.inf):
        with pytest.raises(ValueError):
            service.get_forecast(bad, LON)
        with pytest.raises(ValueError):
            service.get_forecast(LAT, bad)


def test_rejects_out_of_range_and_non_numeric_coordinates():
    service = weather.WeatherService(http_get=FakeGet())
    for lat, lon in ((91.0, LON), (-91.0, LON), (LAT, 181.0), (LAT, -181.0), ("x", LON)):
        with pytest.raises(ValueError):
            service.get_forecast(lat, lon)


def test_accepts_boundary_coordinates():
    service = weather.WeatherService(http_get=FakeGet())
    assert service.get_forecast(-90.0, -180.0, 1)
    assert service.get_forecast(90.0, 180.0, 1)


def test_rejects_invalid_days():
    service = weather.WeatherService(http_get=FakeGet())
    for bad in (0, 8, -1, True, None, 3.0, "3"):
        with pytest.raises(ValueError):
            service.get_forecast(LAT, LON, bad)


def test_query_parameters_are_urlencoded():
    service, getter = make_service()
    service.get_forecast(LAT, LON, 5)
    url = getter.urls[0]
    assert url.startswith(weather.DEFAULT_BASE_URL + "?")
    query = urllib.parse.parse_qs(url.split("?", 1)[1])
    assert query["latitude"] == [f"{LAT:.6f}"]
    assert query["longitude"] == [f"{LON:.6f}"]
    assert query["timezone"] == ["auto"]
    assert query["forecast_days"] == ["5"]
    assert query["current"] == ["temperature_2m,weather_code,wind_speed_10m"]
    assert query["daily"] == [
        "temperature_2m_max,temperature_2m_min,precipitation_probability_max"
    ]


def test_build_forecast_url_validates_too():
    query = urllib.parse.parse_qs(weather.build_forecast_url(1.5, -2.5, 2).split("?", 1)[1])
    assert query["forecast_days"] == ["2"]
    with pytest.raises(ValueError):
        weather.build_forecast_url(999.0, LON, 3)


def test_normalizes_payload():
    service, _ = make_service()
    result = service.get_forecast(LAT, LON)
    assert set(result) == {"location", "timezone", "units", "current", "daily"}
    assert result["location"] == {"latitude": LAT, "longitude": LON}
    assert result["timezone"] == "Europe/Zurich"
    assert result["units"] == {
        "temperature": "\u00b0C",
        "wind_speed": "km/h",
        "precipitation_probability": "%",
    }
    assert result["current"] == {"temperature": 12.5, "weather_code": 2, "wind_speed": 7.4}
    assert result["daily"] == [
        {
            "date": "2026-01-01",
            "temperature_max": 20.0,
            "temperature_min": 10.0,
            "precipitation_probability": 0,
        },
        {
            "date": "2026-01-02",
            "temperature_max": 21.0,
            "temperature_min": 9.0,
            "precipitation_probability": 10,
        },
        {
            "date": "2026-01-03",
            "temperature_max": 22.0,
            "temperature_min": 8.0,
            "precipitation_probability": 20,
        },
    ]


@pytest.mark.parametrize("days", [1, 2, 7])
def test_daily_length_matches_days(days):
    service, _ = make_service()
    result = service.get_forecast(LAT, LON, days)
    assert len(result["daily"]) == days
    assert all(len(entry) == 4 for entry in result["daily"])


def test_defaults_to_three_days():
    service, getter = make_service()
    result = service.get_forecast(LAT, LON)
    assert len(result["daily"]) == 3
    query = urllib.parse.parse_qs(getter.urls[0].split("?", 1)[1])
    assert query["forecast_days"] == ["3"]


def test_null_values_may_stay_none():
    payload = make_payload(2)
    payload["daily"]["precipitation_probability_max"] = [None, 40]
    service, _ = make_service(payload=payload)
    result = service.get_forecast(LAT, LON, 2)
    assert result["daily"][0]["precipitation_probability"] is None
    assert result["daily"][1]["precipitation_probability"] == 40


def test_rejects_missing_sections():
    for payload in ({"timezone": "UTC"}, {"current": {}, "daily": {}}):
        service, _ = make_service(payload=payload)
        with pytest.raises(ValueError):
            service.get_forecast(LAT, LON, 3)


def test_rejects_missing_current_field():
    payload = make_payload(3)
    payload["current"].pop("weather_code")
    service, _ = make_service(payload=payload)
    with pytest.raises(ValueError):
        service.get_forecast(LAT, LON, 3)


@pytest.mark.parametrize(
    "key",
    [
        "time",
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_probability_max",
    ],
)
def test_rejects_missing_daily_arrays(key):
    payload = make_payload(3)
    payload["daily"].pop(key)
    service, _ = make_service(payload=payload)
    with pytest.raises(ValueError):
        service.get_forecast(LAT, LON, 3)


def test_rejects_misaligned_daily_arrays():
    payload = make_payload(3)
    payload["daily"]["temperature_2m_max"] = [20.0, 21.0]
    service, _ = make_service(payload=payload)
    with pytest.raises(ValueError):
        service.get_forecast(LAT, LON, 3)


def test_reports_transport_errors():
    service, _ = make_service(error=urllib.error.URLError("dns failure"))
    with pytest.raises(weather.WeatherServiceError):
        service.get_forecast(LAT, LON)


def test_reports_http_errors():
    http_error = urllib.error.HTTPError(
        weather.DEFAULT_BASE_URL, 502, "Bad Gateway", {}, None
    )
    service, _ = make_service(error=http_error)
    with pytest.raises(weather.WeatherServiceError):
        service.get_forecast(LAT, LON)


def test_reports_malformed_json():
    service, _ = make_service(error=json.JSONDecodeError("boom", "doc", 0))
    with pytest.raises(weather.WeatherServiceError):
        service.get_forecast(LAT, LON)


def test_rejects_non_object_payload():
    service, _ = make_service(payload=[{"unexpected": "list"}])
    with pytest.raises(weather.WeatherServiceError):
        service.get_forecast(LAT, LON)


def test_default_transport_uses_timeout_without_network(monkeypatch):
    captured = {}

    def fake_urlopen(url, timeout=None):
        captured["url"] = url
        captured["timeout"] = timeout
        raise urllib.error.URLError("offline test")

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    service = weather.WeatherService(timeout=4.5)
    with pytest.raises(weather.WeatherServiceError):
        service.get_forecast(LAT, LON)
    assert captured["timeout"] == 4.5
    assert captured["url"].startswith(weather.DEFAULT_BASE_URL)
