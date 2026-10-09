"""Deterministic offline coverage for the disposable Open-Meteo example."""

import json
import math
from importlib.util import module_from_spec
from importlib.util import spec_from_file_location
from pathlib import Path
from urllib.error import HTTPError
from urllib.error import URLError
from urllib.parse import parse_qsl
from urllib.parse import urlparse

import pytest

MODULE_PATH = Path(__file__).parents[2] / "examples/workflow-smoke/weather/weather.py"
SPEC = spec_from_file_location("workflow_smoke_weather", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
weather = module_from_spec(SPEC)
SPEC.loader.exec_module(weather)


def payload(days: int = 3) -> dict:
    """Return a canned Open-Meteo Forecast API response."""
    return {
        "timezone": "Europe/Berlin",
        "current": {
            "temperature_2m": 21.5,
            "weather_code": 3,
            "wind_speed_10m": 12.0,
        },
        "daily": {
            "time": [f"2024-01-0{index + 1}" for index in range(days)],
            "temperature_2m_max": [22.0 + index for index in range(days)],
            "temperature_2m_min": [11.0 + index for index in range(days)],
            "precipitation_probability_max": [10 * index for index in range(days)],
        },
    }


def service_returning(body: object, recorded: list | None = None) -> weather.WeatherService:
    """Build a service whose transport is a canned payload, never a socket."""

    def http_get(url: str) -> bytes:
        if recorded is not None:
            recorded.append(url)
        assert isinstance(body, (bytes, str))
        return body

    return weather.WeatherService(http_get=http_get)


def service_raising(error: BaseException) -> weather.WeatherService:
    def http_get(url: str) -> bytes:
        raise error

    return weather.WeatherService(http_get=http_get)


def make_service(days: int = 3) -> weather.WeatherService:
    return service_returning(json.dumps(payload(days)))


def test_no_default_transport_is_ever_used(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(url, **kwargs):  # pragma: no cover - defensive guard
        raise AssertionError("the default transport must not be used")

    monkeypatch.setattr(weather, "urlopen", forbidden)
    service = weather.WeatherService()
    with pytest.raises(AssertionError, match="must not be used"):
        service.get_forecast(52.52, 13.40)


def test_get_forecast_returns_the_normalized_schema() -> None:
    result = make_service(2).get_forecast(52.52, 13.40, 2)

    assert result["location"] == {"latitude": 52.52, "longitude": 13.40}
    assert result["timezone"] == "Europe/Berlin"
    assert result["units"] == {"temperature_c": "celsius", "wind_speed": "km/h"}
    assert result["current"] == {
        "temperature": 21.5,
        "weather_code": 3.0,
        "wind_speed": 12.0,
    }
    assert result["daily"] == [
        {
            "date": "2024-01-01",
            "temperature_max": 22.0,
            "temperature_min": 11.0,
            "precipitation_probability": 0,
        },
        {
            "date": "2024-01-02",
            "temperature_max": 23.0,
            "temperature_min": 12.0,
            "precipitation_probability": 10,
        },
    ]


@pytest.mark.parametrize("days", [1, 3, 7])
def test_daily_length_matches_the_requested_days(days: int) -> None:
    result = make_service(days).get_forecast(1.0, 2.0, days)

    assert len(result["daily"]) == days
    assert [entry["date"] for entry in result["daily"]] == [
        f"2024-01-{index + 1:02d}" for index in range(days)
    ]


def test_days_defaults_to_three() -> None:
    recorded: list[str] = []
    service = service_returning(json.dumps(payload(3)), recorded)

    result = service.get_forecast(1.0, 2.0)

    assert len(result["daily"]) == 3
    query = dict(parse_qsl(urlparse(recorded[0]).query))
    assert query["forecast_days"] == "3"


@pytest.mark.parametrize("days", [0, 8, -1, 3.0, "3", True, False, None])
def test_get_forecast_rejects_invalid_days(days: object) -> None:
    with pytest.raises(ValueError, match="days"):
        make_service().get_forecast(1.0, 2.0, days)


@pytest.mark.parametrize(
    "arguments",
    [
        (math.nan, 0.0),
        (0.0, math.inf),
        (math.inf, 0.0),
        (91.0, 0.0),
        (-90.5, 0.0),
        (0.0, 181.0),
        (0.0, -180.5),
        ("52.52", 0.0),
        (0.0, None),
    ],
)
def test_get_forecast_rejects_invalid_coordinates(arguments: tuple) -> None:
    with pytest.raises(ValueError, match="latitude|longitude"):
        make_service().get_forecast(*arguments)


def test_request_uses_the_documented_open_meteo_parameters() -> None:
    recorded: list[str] = []
    service = service_returning(json.dumps(payload(4)), recorded)

    service.get_forecast(52.52, 13.4001, 4)

    parsed = urlparse(recorded[0])
    assert parsed.scheme == "https"
    assert parsed.netloc == "api.open-meteo.com"
    assert parsed.path == "/v1/forecast"
    assert parse_qsl(parsed.query) == [
        ("latitude", "52.520000"),
        ("longitude", "13.400100"),
        ("current", "temperature_2m,weather_code,wind_speed_10m"),
        ("daily", ",".join(weather.DAILY_FIELDS)),
        ("timezone", "auto"),
        ("forecast_days", "4"),
    ]


def test_build_url_percent_encodes_the_parameter_lists() -> None:
    url = weather.WeatherService.build_url(1.5, -2.25, 2)

    assert url.startswith(f"{weather.ENDPOINT}?")
    assert "current=temperature_2m%2Cweather_code%2Cwind_speed_10m" in url
    assert url.count("?") == 1


def test_invalid_json_is_reported_as_a_service_error() -> None:
    service = service_returning(b"{'not': broken_json,")

    with pytest.raises(weather.WeatherServiceError, match="unusable"):
        service.get_forecast(1.0, 2.0)


def test_text_payload_is_decoded_as_well_as_bytes() -> None:
    service = service_returning(json.dumps(payload(1)))

    assert service.get_forecast(1.0, 2.0, 1)["timezone"] == "Europe/Berlin"


@pytest.mark.parametrize(
    "broken",
    [
        {**payload(2), "timezone": ""},
        {k: v for k, v in payload(2).items() if k != "timezone"},
        {k: v for k, v in payload(2).items() if k != "current"},
        {k: v for k, v in payload(2).items() if k != "daily"},
        {**payload(2), "daily": {**payload(2)["daily"], "temperature_2m_max": [1.0]}},
        {**payload(2), "daily": {**payload(2)["daily"], "time": []}},
        {**payload(2), "current": {**payload(2)["current"], "weather_code": None}},
    ],
)
def test_broken_payloads_are_reported_as_service_errors(broken: dict) -> None:
    service = service_returning(json.dumps(broken))

    with pytest.raises(weather.WeatherServiceError):
        service.get_forecast(1.0, 2.0, 2)


@pytest.mark.parametrize(
    "error",
    [
        URLError("connection refused"),
        HTTPError("https://example.invalid", 503, "unavailable", {}, None),
        TimeoutError("timed out"),
    ],
)
def test_transport_failures_become_service_errors(error: BaseException) -> None:
    service = service_raising(error)

    with pytest.raises(weather.WeatherServiceError):
        service.get_forecast(1.0, 2.0)


def test_default_transport_honours_the_timeout_and_decodes_bytes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple] = []

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *exc: object) -> None:
            return None

        def read(self) -> bytes:
            return json.dumps(payload(1)).encode()

    def fake_urlopen(url, **kwargs):
        calls.append((url, kwargs))
        return FakeResponse()

    monkeypatch.setattr(weather, "urlopen", fake_urlopen)

    result = weather.WeatherService(timeout=2.5).get_forecast(1.0, 2.0, 1)

    assert result["daily"][0]["date"] == "2024-01-01"
    assert calls[0][1] == {"timeout": 2.5}
