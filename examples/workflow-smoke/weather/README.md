# Open-Meteo `WeatherService` (disposable workflow smoke)

A small, reusable **synchronous** Python client around the public
[Open-Meteo Forecast API](https://open-meteo.com/en/docs)
(`https://api.open-meteo.com/v1/forecast`, source:
https://github.com/open-meteo/open-meteo).

This directory is a disposable end-to-end pipeline test fixture. It is **not**
production functionality and is not wired into the Social MCP application.

## Data source, licence, and attribution

- Open-Meteo makes the Forecast API available **without an API key for
  non-commercial use only**.
- The data is provided by Open-Meteo.com and is licensed under
  **CC BY 4.0** — attribution "Data by Open-Meteo.com" is required.
- **Commercial use is not covered by the free tier.** Using these endpoints for
  a commercial product requires a separate paid licence from Open-Meteo.
  Nothing here grants or implies a right to free commercial use.
- Please respect the upstream terms of service (for example, do not mirror or
  redistribute the raw data).

## Usage

```python
from weather import WeatherService

forecast = WeatherService().get_forecast(47.2692, 9.1621, days=3)

print(forecast["timezone"])    # e.g. "Europe/Zurich"  (timezone=auto)
print(forecast["units"])       # {"temperature": "\u00b0C", "wind_speed": "km/h", ...}
print(forecast["current"])     # {"temperature": ..., "weather_code": ..., "wind_speed": ...}
print(forecast["daily"][0])    # {"date": ..., "temperature_max": ..., "temperature_min": ...,
                               #  "precipitation_probability": ...}
```

`get_forecast(latitude, longitude, days=3)` validates its inputs first and
raises `ValueError` for non-finite coordinates, latitudes outside ±90,
longitudes outside ±180, or `days` outside 1..7.

Requested fields are `current=temperature_2m,weather_code,wind_speed_10m`,
`daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max`,
`timezone=auto`, and `forecast_days=<days>`, URL-encoded with
`urllib.parse.urlencode`.

### Errors

| Problem                                        | Raised                              |
| ---------------------------------------------- | ----------------------------------- |
| Invalid latitude / longitude / `days`          | `ValueError`                        |
| Missing or misaligned `current`/`daily` arrays | `ValueError`                        |
| HTTP, DNS, timeout, or malformed upstream JSON | `WeatherServiceError`               |

## Offline transport injection

`urllib.request` (with a 10 s default timeout) is the default transport, but
`WeatherService(http_get=...)` accepts any callable `str -> dict`, which is how
the tests stay deterministic and offline:

```python
service = WeatherService(http_get=lambda url: {"timezone": "UTC", ...})
```

## Command line

```console
$ python weather.py 47.2692 9.1621 --days 3
```

This performs a real request to Open-Meteo and therefore needs network access;
it is never run by the tests.

## Tests

From the repository root:

```console
$ pytest tests/workflow_smoke/test_weather.py
```

The suite uses only mocked JSON and mocked transport failures — no network
access, no credentials, and no third-party packages.
