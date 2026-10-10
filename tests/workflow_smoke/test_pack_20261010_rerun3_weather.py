"""Deterministic, network-free tests for the pack-20261010-rerun3 WeatherService."""

from __future__ import annotations

import json
import math
import os
import sys
import urllib.error
from urllib.parse import parse_qs, urlparse
import pytest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(TESTS_DIR))
sys.path.insert(
    0,
    os.path.join(
        REPO_ROOT,
        "examples",
        "workflow-smoke",
        "pack-20261010-rerun3",
        "weather",
    ),
)

import weather as mod  # noqa: E402  (path setup must precede import)


def make_payload(days: int = 3) -> dict:
    return {
        "latitude": 52.52,
        "longitude": 13.41,
        "timezone": "Europe/Berlin",
        "current": {
            "time": "2026-10-10T12:00",
            "temperature_2m": 18.5,
            "weather_code": 3,
            "wind_speed_10m": 7.2,
        },
        "current_units": {
            "temperature_2m": "°C",
            "weather_code": "warning code",
            "wind_speed_10m": "km/h",
        },
        "daily": {
            "time": [f"2026-10-{10 + index:02d}" for index in range(days)],
            "temperature_2m_max": [20.0 + index for index in range(days)],
            "temperature_2m_min": [9.0 + index for index in range(days)],
            "precipitation_probability_max": [10 + index for index in range(days)],
        },
        "daily_units": {
            "temperature_2m_max": "°C",
            "temperature_2m_min": "°C",
            "precipitation_probability_max": "%",
        },
    }


def _payload_json(days: int = 3) -> bytes:
    return json.dumps(make_payload(days)).encode("utf-8")


class _Response:
    """Minimal stand-in for a ``urllib.request.urlopen`` HTTP response."""

    def __init__(self, body: bytes, status: int = 200) -> None:
        self._body = body
        self.status = status

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *exc_info) -> bool:
        return False


def service_with(payload, **kwargs):
    calls: list[tuple[str, float]] = []

    def http_get(url, timeout):
        calls.append((url, timeout))
        return payload

    return mod.WeatherService(http_get=http_get, **kwargs), calls


def query_of(url: str) -> dict:
    return parse_qs(urlparse(url).query)


class TestValidation:
    @pytest.mark.parametrize("bad", [float("nan"), float("inf"), -float("inf")])
    def test_rejects_non_finite_latitude(self, bad):
        with pytest.raises(ValueError, match="latitude"):
            mod.WeatherService().get_forecast(bad, 13.41)

    def test_rejects_non_finite_longitude(self):
        with pytest.raises(ValueError, match="longitude"):
            mod.WeatherService().get_forecast(52.52, float("nan"))

    def test_rejects_out_of_range_coordinates(self):
        service = mod.WeatherService()
        with pytest.raises(ValueError, match="latitude"):
            service.get_forecast(90.5, 0.0)
        with pytest.raises(ValueError, match="latitude"):
            service.get_forecast(-91.0, 0.0)
        with pytest.raises(ValueError, match="longitude"):
            service.get_forecast(0.0, 180.5)
        with pytest.raises(ValueError, match="longitude"):
            service.get_forecast(0.0, -181.0)

    @pytest.mark.parametrize("bad", ["52.5", None, [], {}, True])
    def test_rejects_non_numeric_coordinates(self, bad):
        with pytest.raises(ValueError, match="latitude"):
            mod.WeatherService().get_forecast(bad, 13.41)

    def test_accepts_boundary_coordinates(self):
        service, _ = service_with(make_payload(1))
        result = service.get_forecast(90.0, -180.0, days=1)
        assert result["location"] == {"latitude": 52.52, "longitude": 13.41}
        assert result["timezone"] == "Europe/Berlin"
        assert isinstance(result["daily"], list)

    @pytest.mark.parametrize("days", [0, -1, 8, 100])
    def test_rejects_days_out_of_range(self, days):
        with pytest.raises(ValueError, match="days"):
            mod.WeatherService().get_forecast(52.52, 13.41, days=days)

    @pytest.mark.parametrize("days", [3.0, "3", None, True, 2.5])
    def test_rejects_non_integer_days(self, days):
        with pytest.raises(ValueError, match="days"):
            mod.WeatherService().get_forecast(52.52, 13.41, days=days)

    def test_rejects_bad_service_construction(self):
        with pytest.raises(ValueError, match="timeout"):
            mod.WeatherService(timeout=0)
        with pytest.raises(ValueError, match="timeout"):
            mod.WeatherService(timeout=float("nan"))
        with pytest.raises(ValueError, match="timeout"):
            mod.WeatherService(timeout="10")
        with pytest.raises(ValueError, match="base_url"):
            mod.WeatherService(base_url="http://example.invalid/forecast")

    def test_validation_happens_before_transport(self):
        calls: list[str] = []

        def http_get(url, timeout):
            calls.append(url)
            return make_payload()

        service = mod.WeatherService(http_get=http_get)
        with pytest.raises(ValueError, match="latitude"):
            service.get_forecast(1000.0, 13.41)
        assert calls == []


class TestUrl:
    def test_url_endpoint_and_params(self):
        service, _ = service_with(make_payload(5))
        url = service.build_url(52.52, 13.41, days=5)
        parsed = urlparse(url)
        assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == mod.DEFAULT_BASE_URL
        assert parsed.scheme == "https"
        params = query_of(url)
        assert params["latitude"] == ["52.52"]
        assert params["longitude"] == ["13.41"]
        assert params["current"] == ["temperature_2m,weather_code,wind_speed_10m"]
        assert params["daily"] == [
            "temperature_2m_max,temperature_2m_min,precipitation_probability_max"
        ]
        assert params["timezone"] == ["auto"]
        assert params["forecast_days"] == ["5"]

    def test_default_days_is_three(self):
        service, calls = service_with(make_payload(3))
        service.get_forecast(52.52, 13.41)
        assert query_of(calls[0][0])["forecast_days"] == ["3"]
        assert calls[0][1] == mod.DEFAULT_TIMEOUT

    def test_no_spaces_and_days_1_to_7_urls(self):
        service, _ = service_with(make_payload(1))
        for days in range(1, mod.MAX_FORECAST_DAYS + 1):
            url = service.build_url(52.52, 13.41, days=days)
            assert " " not in url
            assert query_of(url)["forecast_days"] == [str(days)]


class TestNormalization:
    def test_schema_and_values(self):
        service, _ = service_with(make_payload(3))
        result = service.get_forecast(52.52, 13.41, days=3)

        assert set(result) == {"location", "timezone", "units", "current", "daily"}
        assert result["location"] == {"latitude": 52.52, "longitude": 13.41}
        assert result["timezone"] == "Europe/Berlin"
        assert result["units"] == {
            "temperature": "°C",
            "wind_speed": "km/h",
            "precipitation_probability": "%",
        }
        assert result["current"] == {
            "temperature": 18.5,
            "weather_code": 3,
            "wind_speed": 7.2,
        }
        assert result["daily"][0] == {
            "date": "2026-10-10",
            "temperature_min": 9.0,
            "temperature_max": 20.0,
            "precipitation_probability": 10.0,
        }
        assert all(math.isfinite(value) for entry in result["daily"] for value in entry.values()
                   if isinstance(value, float))

    @pytest.mark.parametrize("days", [1, 2, 3, 7])
    def test_daily_length_matches_request(self, days):
        service, _ = service_with(make_payload(days))
        result = service.get_forecast(52.52, 13.41, days=days)
        assert len(result["daily"]) == days
        assert [entry["date"] for entry in result["daily"]] == [
            f"2026-10-{10 + index:02d}" for index in range(days)
        ]

    def test_accepts_json_bytes_and_str_payloads(self):
        import json

        for dumps in (json.dumps(make_payload(2)).encode("utf-8"), json.dumps(make_payload(2))):
            service, _ = service_with(dumps)
            assert len(service.get_forecast(52.52, 13.41, days=2)["daily"]) == 2

    def test_units_fallback_when_absent(self):
        payload = make_payload(1)
        payload.pop("current_units")
        payload.pop("daily_units")
        service, _ = service_with(payload)
        assert service.get_forecast(52.52, 13.41, days=1)["units"] == {
            "temperature": "°C",
            "wind_speed": "km/h",
            "precipitation_probability": "%",
        }


class TestTransportFailures:
    def test_injected_getter_exception_propagates(self):
        service, _ = service_with(mod.WeatherError("upstream returned HTTP 503"))
        with pytest.raises(mod.WeatherError, match="HTTP 503"):
            service.get_forecast(52.52, 13.41)

    def test_default_transport_maps_url_error_to_weather_error(self, monkeypatch):
        def fake_urlopen(request, timeout=None):
            raise urllib.error.URLError("dns failure")

        monkeypatch.setattr(mod.urllib.request, "urlopen", fake_urlopen)
        with pytest.raises(mod.WeatherError, match="forecast request failed"):
            mod.WeatherService().get_forecast(52.52, 13.41)

    def test_default_transport_maps_http_error_to_weather_error(self, monkeypatch):
        def fake_urlopen(request, timeout=None):
            raise urllib.error.HTTPError("https://x", 429, "Too Many", {}, None)

        monkeypatch.setattr(mod.urllib.request, "urlopen", fake_urlopen)
        with pytest.raises(mod.WeatherError, match="HTTP 429"):
            mod.WeatherService().get_forecast(52.52, 13.41)

    def test_default_transport_rejects_non_200_status(self, monkeypatch):
        monkeypatch.setattr(mod.urllib.request, "urlopen", lambda request, timeout=None: _Response(b"{}", 204))
        with pytest.raises(mod.WeatherError, match="HTTP 204"):
            mod.WeatherService().get_forecast(52.52, 13.41)

    def test_default_transport_uses_timeout_and_url(self, monkeypatch):
        seen = {}

        def fake_urlopen(request, timeout=None):
            seen["timeout"] = timeout
            seen["url"] = request.full_url
            return _Response(_payload_json(1))

        monkeypatch.setattr(mod.urllib.request, "urlopen", fake_urlopen)
        result = mod.WeatherService(timeout=2.5).get_forecast(52.52, 13.41, days=1)
        assert len(result["daily"]) == 1
        assert seen["timeout"] == 2.5
        assert seen["url"].startswith(mod.DEFAULT_BASE_URL)

    def test_no_network_is_used(self, monkeypatch):
        def forbidden(*args, **kwargs):
            raise AssertionError("network access is forbidden in tests")

        monkeypatch.setattr(mod.urllib.request, "urlopen", forbidden)
        service, _ = service_with(make_payload(2))
        assert len(service.get_forecast(52.52, 13.41, days=2)["daily"]) == 2


class TestResponseShapeFailures:
    @pytest.mark.parametrize("raw", [b"not json", "{oops", b"", 123, [1, 2], "[]"])
    def test_malformed_json(self, raw):
        service, _ = service_with(raw)
        with pytest.raises(mod.WeatherError):
            service.get_forecast(52.52, 13.41)

    @pytest.mark.parametrize(
        "path",
        [
            ("latitude",),
            ("longitude",),
            ("timezone",),
            ("current",),
            ("daily",),
            ("current", "temperature_2m"),
            ("current", "weather_code"),
            ("current", "wind_speed_10m"),
            ("daily", "time"),
            ("daily", "temperature_2m_max"),
            ("daily", "temperature_2m_min"),
            ("daily", "precipitation_probability_max"),
        ],
    )
    def test_missing_required_field(self, path):
        payload = make_payload(3)
        target = payload
        for key in path[:-1]:
            target = target[key]
        del target[path[-1]]
        service, _ = service_with(payload)
        with pytest.raises(mod.WeatherError):
            service.get_forecast(52.52, 13.41, days=3)

    def test_empty_timezone_is_rejected(self):
        payload = make_payload(3)
        payload["timezone"] = "   "
        service, _ = service_with(payload)
        with pytest.raises(mod.WeatherError, match="timezone"):
            service.get_forecast(52.52, 13.41, days=3)

    def test_misaligned_daily_array_is_rejected(self):
        payload = make_payload(3)
        payload["daily"]["temperature_2m_min"] = [9.0, 10.0]
        service, _ = service_with(payload)
        with pytest.raises(mod.WeatherError, match="misaligned"):
            service.get_forecast(52.52, 13.41, days=3)

    def test_more_daily_entries_than_days_is_rejected(self):
        service, _ = service_with(make_payload(5))
        with pytest.raises(mod.WeatherError, match="1..3"):
            service.get_forecast(52.52, 13.41, days=3)

    def test_empty_daily_is_rejected(self):
        payload = make_payload(0)
        service, _ = service_with(payload)
        with pytest.raises(mod.WeatherError):
            service.get_forecast(52.52, 13.41, days=3)

    def test_non_numeric_daily_entry_is_rejected(self):
        payload = make_payload(2)
        payload["daily"]["temperature_2m_max"] = [20.0, "warm"]
        service, _ = service_with(payload)
        with pytest.raises(mod.WeatherError, match="temperature_2m_max"):
            service.get_forecast(52.52, 13.41, days=2)

    def test_non_string_daily_date_is_rejected(self):
        payload = make_payload(2)
        payload["daily"]["time"] = [None, "2026-10-11"]
        service, _ = service_with(payload)
        with pytest.raises(mod.WeatherError, match="date string"):
            service.get_forecast(52.52, 13.41, days=2)

    def test_non_integer_weather_code_is_rejected(self):
        payload = make_payload(1)
        payload["current"]["weather_code"] = "clear"
        service, _ = service_with(payload)
        with pytest.raises(mod.WeatherError, match="weather_code"):
            service.get_forecast(52.52, 13.41, days=1)
