"""
weather_sources.py
==================
Concrete download functions for two freely available weather datasets:

  1. NOAA GHCN-Daily (Global Historical Climatology Network)
     - No API key required for the public FTP/HTTPS mirror
     - Per-station CSV files updated daily
     - Station IDs chosen to give geographic diversity and long records

  2. Open-Meteo Historical Weather API
     - Completely free, no API key, no rate-limit registration
     - Returns hourly or daily data for any lat/lon on earth
     - JSON response, easily normalised to a DataFrame

Both functions follow the same contract:
    download_*(...) -> str          # returns local file path written to /tmp

These are called from Airflow DAG tasks. The DAG then uploads the result
to MinIO using upload_file() from minio_helper.py.

Recommended stations / locations
---------------------------------
GHCN-Daily station IDs (long records, geographically diverse):
    USW00094728  — New York Central Park, US    (1869-present)
    USW00023174  — Los Angeles Int'l Airport, US (1944-present)
    UKW00035065  — London Heathrow, UK           (1948-present)
    JA000047662  — Tokyo, Japan                  (1875-present)
    ASN00086282  — Melbourne, Australia           (1855-present)

Open-Meteo locations (lat, lon, label):
    (40.7128, -74.0060, "new_york")
    (51.5074, -0.1278,  "london")
    (35.6762, 139.6503, "tokyo")
    (-37.8136, 144.9631, "melbourne")
    (1.3521, 103.8198,  "singapore")
"""

import logging
import os
import time
from typing import Optional

import requests

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# NOAA GHCN-Daily
# ---------------------------------------------------------------------------
# Base URL for the per-station CSV files (HTTPS mirror of the NOAA FTP).
# The URL pattern is: {BASE}/{STATION_ID}.csv
# Documentation: https://www.ncei.noaa.gov/pub/data/ghcn/daily/readme.txt
GHCN_BASE_URL = "https://www.ncei.noaa.gov/pub/data/ghcn/daily/by_station"

# Curated list of stations with long, high-quality records.
# Tuple format: (station_id, human_readable_label)
GHCN_STATIONS = [
    ("USW00094728", "new_york_central_park"),
    ("USW00023174", "los_angeles_lax"),
    ("UKW00035065", "london_heathrow"),
    ("JA000047662", "tokyo"),
    ("ASN00086282", "melbourne"),
]


def download_ghcn_station(
    station_id: str,
    output_dir: str = "/tmp",
    timeout_seconds: int = 120,
) -> str:
    """
    Download the full GHCN-Daily CSV for one station.

    The file is saved to {output_dir}/{station_id}.csv.
    If the file already exists locally it is overwritten (the DAG's
    MinIO-first check prevents redundant downloads at the DAG level).

    Parameters
    ----------
    station_id : str
        NOAA GHCN station identifier, e.g. "USW00094728".
    output_dir : str
        Directory to write the downloaded CSV.
    timeout_seconds : int
        HTTP request timeout. GHCN CSVs can be several MB.

    Returns
    -------
    str
        Absolute path of the downloaded file.

    Raises
    ------
    requests.HTTPError
        If the server returns a non-2xx status code.
    """
    url = f"{GHCN_BASE_URL}/{station_id}.csv"
    output_path = os.path.join(output_dir, f"{station_id}.csv")

    log.info("Downloading GHCN station %s from %s", station_id, url)
    start = time.monotonic()

    # stream=True so we don't load the whole response into memory at once
    response = requests.get(url, timeout=timeout_seconds, stream=True)
    response.raise_for_status()

    bytes_written = 0
    with open(output_path, "wb") as fh:
        for chunk in response.iter_content(chunk_size=65536):
            fh.write(chunk)
            bytes_written += len(chunk)

    elapsed = time.monotonic() - start
    log.info(
        "Downloaded %s: %d bytes in %.1f seconds → %s",
        station_id,
        bytes_written,
        elapsed,
        output_path,
    )
    return output_path


def download_all_ghcn_stations(
    stations: list = None,
    output_dir: str = "/tmp",
) -> dict:
    """
    Download GHCN-Daily CSVs for all stations in the provided list.

    Parameters
    ----------
    stations : list of (station_id, label) tuples, optional
        Defaults to GHCN_STATIONS defined at the top of this module.
    output_dir : str
        Directory to write downloaded CSVs.

    Returns
    -------
    dict
        Mapping of station_id → local file path.
    """
    if stations is None:
        stations = GHCN_STATIONS

    results = {}
    for station_id, label in stations:
        try:
            path = download_ghcn_station(station_id, output_dir=output_dir)
            results[station_id] = path
        except Exception as exc:
            # Log and continue — a single failed station should not abort the run
            log.error("Failed to download station %s (%s): %s", station_id, label, exc)

    return results


# ---------------------------------------------------------------------------
# Open-Meteo Historical Weather API
# ---------------------------------------------------------------------------
# Docs: https://open-meteo.com/en/docs/historical-weather-api
# Free tier: unlimited requests, no API key, data from 1940 to present.
OPEN_METEO_URL = "https://archive-api.open-meteo.com/v1/archive"

# Locations to fetch (lat, lon, label)
OPEN_METEO_LOCATIONS = [
    (40.7128, -74.0060, "new_york"),
    (51.5074, -0.1278, "london"),
    (35.6762, 139.6503, "tokyo"),
    (-37.8136, 144.9631, "melbourne"),
    (1.3521, 103.8198, "singapore"),
]

# Daily variables available from the Open-Meteo historical API.
# These cover the core weather quantities: temperature, precipitation,
# wind, and solar radiation.
OPEN_METEO_DAILY_VARIABLES = [
    "temperature_2m_max",       # Max daily temperature at 2 m (°C)
    "temperature_2m_min",       # Min daily temperature at 2 m (°C)
    "temperature_2m_mean",      # Mean daily temperature at 2 m (°C)
    "precipitation_sum",        # Total daily precipitation (mm)
    "rain_sum",                 # Rain component of precipitation (mm)
    "snowfall_sum",             # Snowfall (cm water equivalent)
    "wind_speed_10m_max",       # Max daily wind speed at 10 m (km/h)
    "wind_gusts_10m_max",       # Max daily wind gusts at 10 m (km/h)
    "shortwave_radiation_sum",  # Daily solar radiation (MJ/m²)
]


def download_open_meteo(
    latitude: float,
    longitude: float,
    location_label: str,
    start_date: str = "2020-01-01",
    end_date: str = "2024-12-31",
    daily_variables: list = None,
    output_dir: str = "/tmp",
    timeout_seconds: int = 60,
) -> str:
    """
    Download daily historical weather data from Open-Meteo for one location.

    The response is a JSON object with a "daily" key containing parallel
    arrays. This function flattens those arrays into a CSV and writes it
    to {output_dir}/open_meteo_{location_label}.csv.

    Parameters
    ----------
    latitude : float
        WGS-84 latitude of the location.
    longitude : float
        WGS-84 longitude of the location.
    location_label : str
        Short name used in the output filename, e.g. "new_york".
    start_date : str
        First day of the requested range (ISO 8601, "YYYY-MM-DD").
    end_date : str
        Last day of the requested range (ISO 8601, "YYYY-MM-DD").
    daily_variables : list of str, optional
        Open-Meteo variable names to request. Defaults to
        OPEN_METEO_DAILY_VARIABLES.
    output_dir : str
        Directory for the output CSV.
    timeout_seconds : int
        HTTP request timeout.

    Returns
    -------
    str
        Absolute path of the written CSV file.

    Raises
    ------
    requests.HTTPError
        If the API returns a non-2xx status.
    KeyError
        If the expected "daily" key is missing from the response — this
        can happen if the API changes its schema.
    """
    import pandas as pd  # local import so the module is usable without pandas

    if daily_variables is None:
        daily_variables = OPEN_METEO_DAILY_VARIABLES

    params = {
        "latitude": latitude,
        "longitude": longitude,
        "start_date": start_date,
        "end_date": end_date,
        "daily": daily_variables,
        "timezone": "UTC",
    }

    log.info(
        "Fetching Open-Meteo data for %s (%.4f, %.4f) %s to %s",
        location_label,
        latitude,
        longitude,
        start_date,
        end_date,
    )

    response = requests.get(OPEN_METEO_URL, params=params, timeout=timeout_seconds)
    response.raise_for_status()

    data = response.json()

    # The "daily" block contains a "time" key plus one key per variable.
    # Each value is a list of the same length.
    if "daily" not in data:
        raise KeyError(
            f"Open-Meteo response missing 'daily' key. "
            f"Keys present: {list(data.keys())}"
        )

    daily = data["daily"]
    df = pd.DataFrame(daily)

    # Rename "time" → "date" for clarity
    if "time" in df.columns:
        df.rename(columns={"time": "date"}, inplace=True)

    # Add location metadata columns so multi-location CSVs can be stacked
    df.insert(0, "location", location_label)
    df.insert(1, "latitude", latitude)
    df.insert(2, "longitude", longitude)

    output_path = os.path.join(output_dir, f"open_meteo_{location_label}.csv")
    df.to_csv(output_path, index=False)

    log.info(
        "Wrote %d rows to %s",
        len(df),
        output_path,
    )
    return output_path


def download_all_open_meteo(
    locations: list = None,
    start_date: str = "2020-01-01",
    end_date: str = "2024-12-31",
    output_dir: str = "/tmp",
) -> dict:
    """
    Download Open-Meteo daily data for all locations in the provided list.

    Parameters
    ----------
    locations : list of (lat, lon, label) tuples, optional
        Defaults to OPEN_METEO_LOCATIONS.
    start_date : str
        Start of the date range.
    end_date : str
        End of the date range.
    output_dir : str
        Output directory for CSVs.

    Returns
    -------
    dict
        Mapping of location_label → local file path.
    """
    if locations is None:
        locations = OPEN_METEO_LOCATIONS

    results = {}
    for lat, lon, label in locations:
        try:
            path = download_open_meteo(
                latitude=lat,
                longitude=lon,
                location_label=label,
                start_date=start_date,
                end_date=end_date,
                output_dir=output_dir,
            )
            results[label] = path
        except Exception as exc:
            log.error("Failed to download Open-Meteo data for %s: %s", label, exc)

    return results
