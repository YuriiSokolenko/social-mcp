# Open-Meteo weather forecast service

A small, dependency-free, synchronous weather service for workflow smoke
testing. It is disposable example code, not product functionality: nothing in
the MCP server imports it.

## Usage

```python
from weather import WeatherService

result = WeatherService().get_forecast(52.52, 13.41, days=3)

print(result["timezone"])  # resolved by the upstream API ("timezone=auto")
print(result["units"])  # {"temperature_c": "celsius", "wind_speed": "km/h"}
print(result["current"])  # temperature, weather_code, wind_speed
for entry in result["daily"]:
    print(entry["date"], entry["temperature_max"], entry["temperature_min"])
```

`get_forecast(latitude, longitude, days=3)` validates its arguments (both
coordinates must be finite, `latitude` within ±90, `longitude` within ±180,
`days` an `int` in `1..7`), builds the request with
`urllib.parse.urlencode`, and returns `location`, `timezone`, `units`,
`current`, and exactly `days` `daily` entries.

Invalid input raises `ValueError`. Anything that goes wrong downstream, such as
an HTTP failure, a timeout, malformed JSON, or a missing or misaligned
`daily` array, raises `WeatherServiceError` instead of leaking transport or
`json` exceptions.

Requests select `current=temperature_2m,weather_code,wind_speed_10m`,
`daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max`,
`timezone=auto`, and `forecast_days=<days>` against
`https://api.open-meteo.com/v1/forecast`.

## Testing without network access

The constructor accepts an `http_get(url)` callable, so tests inject canned
JSON and error conditions:

```python
service = WeatherService(http_get=lambda url: b'{"timezone": "UTC", ...}')
```

`tests/workflow_smoke/test_weather.py` uses that seam only; it never opens a
socket and additionally guards the default transport with `monkeypatch`.

## Data licence and attribution (read before commercial use)

* Open-Meteo's data and API are provided under the **Creative Commons
  Attribution 4.0 International (CC BY 4.0)** licence: derived output must
  credit Open-Meteo (https://open-meteo.com) and the meteorological sources it
  redistributes.
* The hosted endpoint is free **for non-commercial use only** and needs no API
  key for that tier. It is **not** free for commercial use: commercial or
  production traffic requires Open-Meteo's own commercial plan. Nothing here
  implies a right to free commercial use.
* See https://open-meteo.com/en/docs for the API contract and
  https://github.com/open-meteo/open-meteo for the upstream project.
