"""weather_get tool — current conditions + today's forecast.

Location resolution, in priority order:
  1. An explicit `location` argument (geocoded by name via Open-Meteo).
  2. WEATHER_LOCATION env var, if set (a fixed city name override).
  3. The machine's actual current location via macOS Location Services
     (CoreLocationCLI, https://github.com/fulldecent/corelocationcli).
  4. IP geolocation (ip-api.com), if CoreLocationCLI is missing, denied, or times out.

Weather itself comes from Open-Meteo. WEATHER_UNITS (fahrenheit|celsius) picks units.
Uses httpx for HTTP and the CoreLocationCLI binary (via subprocess) for device location.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from typing import Any

from app import tool_threaded

try:
    import httpx

    _AVAILABLE = True
except ImportError:  # pragma: no cover
    httpx = None
    _AVAILABLE = False

# WMO weather interpretation codes → short description.
_WMO = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
    45: "fog", 48: "rime fog", 51: "light drizzle", 53: "drizzle", 55: "dense drizzle",
    56: "freezing drizzle", 57: "freezing drizzle", 61: "light rain", 63: "rain",
    65: "heavy rain", 66: "freezing rain", 67: "freezing rain", 71: "light snow",
    73: "snow", 75: "heavy snow", 77: "snow grains", 80: "rain showers",
    81: "rain showers", 82: "violent rain showers", 85: "snow showers",
    86: "snow showers", 95: "thunderstorm", 96: "thunderstorm w/ hail",
    99: "thunderstorm w/ hail",
}

_UNITS = os.getenv("WEATHER_UNITS", "fahrenheit")
_FIXED_LOCATION = os.getenv("WEATHER_LOCATION") or None

_CORELOCATIONCLI = shutil.which("CoreLocationCLI")


class LocationError(RuntimeError):
    """Raised when no location source could resolve a place."""


def _device_location() -> dict[str, Any]:
    """Resolve the machine's current location via macOS Location Services.

    Raises LocationError if CoreLocationCLI isn't installed, permission was
    denied, the request times out, or output can't be parsed.
    """
    if not _CORELOCATIONCLI:
        raise LocationError("CoreLocationCLI is not installed (brew install corelocationcli).")
    try:
        proc = subprocess.run(
            [_CORELOCATIONCLI, "--json"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except subprocess.TimeoutExpired as exc:
        raise LocationError("Timed out waiting for macOS Location Services.") from exc
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "unknown error").strip()
        raise LocationError(f"macOS location lookup failed: {detail}")
    try:
        data = json.loads(proc.stdout)
        lat = float(data["latitude"])
        lon = float(data["longitude"])
    except (json.JSONDecodeError, KeyError, ValueError) as exc:
        raise LocationError(f"Couldn't parse CoreLocationCLI output: {exc}") from exc
    label = ", ".join(
        p for p in [data.get("locality"), data.get("administrativeArea"), data.get("isoCountryCode")] if p
    ) or "current location"
    return {"lat": lat, "lon": lon, "label": label}


def _geocode_by_name(location: str) -> dict[str, Any]:
    """Resolve a place name to lat/lon/label via Open-Meteo's geocoder."""
    geo = _get_json(
        "https://geocoding-api.open-meteo.com/v1/search",
        params={"name": location, "count": 1},
    )
    results = geo.get("results") or []
    if not results:
        raise ValueError(f"Couldn't find location {location!r}.")
    r = results[0]
    label = ", ".join(p for p in [r.get("name"), r.get("admin1"), r.get("country_code")] if p)
    return {"lat": r["latitude"], "lon": r["longitude"], "label": label}


def _ip_location() -> dict[str, Any]:
    """Resolve location by public IP (coarse — city-level at best)."""
    ip = _get_json("http://ip-api.com/json")
    if ip.get("status") != "success":
        raise LocationError(f"IP geolocation failed: {ip.get('message', 'unknown error')}")
    return {
        "lat": ip["lat"],
        "lon": ip["lon"],
        "label": ", ".join(p for p in [ip.get("city"), ip.get("region"), ip.get("countryCode")] if p),
    }


def _resolve_location(location: str | None) -> dict[str, Any]:
    """Apply the location priority order documented at module top."""
    if location:
        return _geocode_by_name(location)
    if _FIXED_LOCATION:
        return _geocode_by_name(_FIXED_LOCATION)
    try:
        return _device_location()
    except LocationError:
        return _ip_location()


def _get_json(url: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """GET a URL and parse JSON, retrying once on transient errors.

    Open-Meteo sometimes returns HTTP 200 with an `{"error": true, ...}` body
    during backend outages, so that shape is treated as a failure too.
    """
    last_exc: Exception | None = None
    for _attempt in range(2):
        try:
            resp = httpx.get(url, params=params, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, dict) and data.get("error"):
                raise RuntimeError(data.get("reason", "upstream API returned an error"))
            return data
        except Exception as exc:  # noqa: BLE001 - retry once, then surface the last error
            last_exc = exc
    raise last_exc  # type: ignore[misc]


def fetch_weather(location: str | None = None, units: str | None = None) -> dict[str, Any]:
    """Return structured current + today weather. Raises on network/lookup error."""
    if not _AVAILABLE:
        raise RuntimeError("Weather needs httpx (pip install httpx).")
    units = units or _UNITS
    place = _resolve_location(location)
    data = _get_json(
        "https://api.open-meteo.com/v1/forecast",
        params={
            "latitude": place["lat"],
            "longitude": place["lon"],
            "current": "temperature_2m,apparent_temperature,weather_code",
            "daily": "temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max",
            "temperature_unit": units,
            "timezone": "auto",
            "forecast_days": 1,
        },
    )
    cur = data.get("current", {})
    daily = data.get("daily", {})
    unit_sym = "°F" if units == "fahrenheit" else "°C"
    return {
        "location": place["label"],
        "now_temp": cur.get("temperature_2m"),
        "feels_like": cur.get("apparent_temperature"),
        "now_desc": _WMO.get(cur.get("weather_code"), "unknown"),
        "high": (daily.get("temperature_2m_max") or [None])[0],
        "low": (daily.get("temperature_2m_min") or [None])[0],
        "today_desc": _WMO.get((daily.get("weather_code") or [None])[0], "unknown"),
        "precip_chance": (daily.get("precipitation_probability_max") or [None])[0],
        "unit": unit_sym,
    }


def summary(w: dict[str, Any]) -> str:
    """One-line human-friendly summary from a fetch_weather() dict."""
    u = w["unit"]
    precip = f", {w['precip_chance']}% chance of precip" if w.get("precip_chance") is not None else ""
    return (
        f"{w['location']}: {w['now_desc']}, {w['now_temp']}{u} "
        f"(feels {w['feels_like']}{u}). Today: {w['today_desc']}, "
        f"high {w['high']}{u} / low {w['low']}{u}{precip}."
    )


@tool_threaded()
def weather_get(location: str = "") -> str:
    """Get current weather and today's forecast.

    Optionally pass a location (city name); otherwise uses the computer's actual
    current location via macOS Location Services, falling back to IP-based
    geolocation if that's unavailable.

    Args:
        location: City/place name (optional).
    """
    try:
        return summary(fetch_weather(location or None))
    except Exception as exc:  # noqa: BLE001
        return f"Couldn't get weather: {exc}"
