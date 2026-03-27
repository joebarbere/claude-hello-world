# Specification: Data Science Initiative — Realistic Weather Profiles for Minion-Generated Forecasts

**Status**: Draft
**Date**: 2026-03-26
**Scope**: Jupyter notebooks, Airflow DAGs, MinIO bucket structure, and open dataset selection
**Audience**: Developers new to both data science and weather science

---

## Problem Statement

Minions are automated background jobs defined in the `Minion` table and executed by `MinionSchedulerService.cs`. Each minion periodically calls `GenerateRandomForecast()`, which produces a `WeatherForecast` record using a uniform random draw: any temperature from -20 to 55°C is equally likely, and any of the ten summary labels is equally likely regardless of temperature.

This is meteorologically implausible. In reality:

- A temperature of 52°C occurs in very few places on Earth and never in northern latitudes.
- "Freezing" is never assigned to a 40°C day.
- Temperatures cluster around seasonal norms; extreme values are rare.
- Summary labels should be correlated with the numeric temperature (a "Scorching" label should only appear above roughly 35°C).

The goal of this initiative is to use real historical weather data to build **statistical profiles** — probability distributions for temperature and summary — that minions can draw from instead of a uniform random range. The end state is minions that produce data that looks like it came from a real weather station.

---

## Architecture Context

| Component | Location | Role |
|-----------|----------|------|
| `MinionSchedulerService.cs` | `apps/weather-api/Services/` | Calls `GenerateRandomForecast()` every 30s tick |
| `WeatherForecast` model | `apps/weather-api/Models/WeatherForecast.cs` | `Id`, `Date`, `TemperatureC`, `Summary` |
| `Minion` model | `apps/weather-api/Models/Minion.cs` | `Name`, `ScheduleType`, `ScheduleValue`, `IsActive`, `LastRunAt` |
| Debezium CDC | `apps/kafka/debezium-init/register-connector.sh` | Captures all `public.*` changes → Kafka (Avro, topic prefix `weather`) |
| Kafka topics | runtime | `weather.public.WeatherForecasts`, `weather.public.Minions` |
| Airflow | `apps/datascience/airflow/` | `apache/airflow:slim-2.10.4-python3.11`; providers: `duckdb`, `minio` |
| Jupyter | `apps/datascience/jupyter/` | `quay.io/jupyter/minimal-notebook`; packages: `duckdb`, `pandas`, `pyarrow`, `minio`, `boto3` |
| MinIO | runtime (S3-compatible) | Object storage for raw datasets, cleaned data, outputs |
| DuckDB | runtime (embedded in Airflow/Jupyter) | Analytical SQL over Parquet files in MinIO |

**CDC note**: Any future change to the `WeatherForecasts` schema automatically flows through Debezium to Kafka. No manual CDC reconfiguration is needed unless a new table is added outside `public.*`.

---

## Part 1: Open-Source Weather Datasets

Three datasets are recommended. They are listed in order of recommended adoption (start with Dataset 1, add the others as the team gains confidence).

---

### Dataset 1: NOAA Global Surface Summary of the Day (GSOD)

**URL**: `https://www.ncei.noaa.gov/data/global-summary-of-the-day/access/`
**License**: U.S. Government Works — public domain, no attribution required for non-commercial or commercial use
**Format**: CSV, one file per station per year
**Approximate size**: ~50 MB per year of global data; ~500 KB per individual station-year file
**API key required**: No

**What it contains**:

| Column | Meteorological meaning | Unit |
|--------|------------------------|------|
| `STATION` | WMO station identifier (5-digit) | — |
| `DATE` | Observation date | YYYY-MM-DD |
| `TEMP` | Mean daily air temperature | Fahrenheit (must convert to Celsius: `(F - 32) * 5/9`) |
| `DEWP` | Mean daily dew point | Fahrenheit |
| `SLP` | Mean sea-level pressure | hPa |
| `WDSP` | Mean wind speed (sustained, 2-min average) | Knots (convert to km/h: `knots * 1.852`) |
| `MXSPD` | Maximum sustained wind speed | Knots |
| `GUST` | Maximum wind gust speed | Knots |
| `MAX` | Daily maximum air temperature | Fahrenheit |
| `MIN` | Daily minimum air temperature | Fahrenheit |
| `PRCP` | Total precipitation | Inches |
| `SNDP` | Snow depth | Inches |
| `FRSHTT` | Binary flags: Fog, Rain, Snow, Hail, Thunder, Tornado | 6-bit integer |

**Time range**: 1929 to present (most stations from 1973 onward with reliable coverage)
**Geographic coverage**: ~29,000 stations worldwide including all major city airports

**How to download (no API key)**:

```bash
# Single station (New York JFK = station 74486099999), full year 2024
curl -o jfk_2024.csv \
  "https://www.ncei.noaa.gov/data/global-summary-of-the-day/access/2024/74486099999.csv"

# Station list (all stations, ~5 MB)
curl -o isd-history.csv \
  "https://www.ncei.noaa.gov/pub/data/noaa/isd-history.csv"
```

**Why it's useful for this project**: GSOD is daily granularity — exactly matching the `WeatherForecast.Date` field, which is `DateOnly`. It provides real temperature ranges per month per city. From this data you can compute: mean daily temperature by month, standard deviation, and the conditional probability of each summary label given temperature. The `FRSHTT` flags map directly to existing condition labels (Foggy, Stormy, Snowy, Hail, Rainy).

**Stations matching the 10 streaming cities**:

| City | GSOD Station ID | Airport |
|------|----------------|---------|
| New York | 74486099999 | JFK |
| London | 03772099999 | Heathrow |
| Tokyo | 47662099999 | Haneda |
| Sydney | 94767099999 | Kingsford Smith |
| Paris | 07156099999 | CDG |
| Berlin | 10384099999 | Tegel |
| Mumbai | 43003099999 | CSIA |
| Sao Paulo | 83779099999 | Congonhas |
| Cairo | 62366099999 | Cairo Intl |
| Toronto | 71265099999 | Pearson |

---

### Dataset 2: Open-Meteo Historical Weather API

**URL**: `https://archive-api.open-meteo.com/v1/archive`
**License**: Creative Commons Attribution 4.0 (CC BY 4.0) — free for commercial and non-commercial use; attribution required
**Format**: JSON (or CSV via parameter)
**Approximate size**: ~1 MB per city per year of hourly data; ~50 KB per city per year of daily data
**API key required**: No (rate-limited; a paid plan removes limits — free tier is sufficient for batch downloads)

**What it contains** (daily aggregates, selectable):

| Parameter name | Meteorological meaning | Unit |
|----------------|------------------------|------|
| `temperature_2m_max` | Daily maximum air temperature at 2m | Celsius |
| `temperature_2m_min` | Daily minimum air temperature at 2m | Celsius |
| `temperature_2m_mean` | Daily mean air temperature at 2m | Celsius |
| `precipitation_sum` | Total daily accumulated precipitation | mm |
| `rain_sum` | Rainfall component of precipitation | mm |
| `snowfall_sum` | Snowfall in snow-water equivalent | mm |
| `wind_speed_10m_max` | Maximum sustained wind speed at 10m | km/h |
| `wind_gusts_10m_max` | Maximum wind gust speed at 10m | km/h |
| `wind_direction_10m_dominant` | Prevailing wind direction | Degrees (0=N, 90=E) |
| `weathercode` | WMO weather interpretation code (0=Clear sky, 95=Thunderstorm) | Integer |
| `et0_fao_evapotranspiration` | Reference evapotranspiration (agriculture) | mm |

**Time range**: 1940 to present (ERA5 reanalysis; actual station data from 1979 onward)
**Geographic coverage**: Global grid (any latitude/longitude coordinate)

**How to download**:

```bash
# Daily data for New York (lat=40.71, lon=-74.01), Jan 2020 - Dec 2024
curl -o nyc_daily_2020_2024.json \
  "https://archive-api.open-meteo.com/v1/archive?latitude=40.71&longitude=-74.01&start_date=2020-01-01&end_date=2024-12-31&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,wind_speed_10m_max,weathercode&timezone=America/New_York"
```

**Why it's useful for this project**: Open-Meteo returns data in Celsius natively, eliminating the unit conversion step required for GSOD. The `weathercode` column maps cleanly to our ten condition labels (see the WMO code mapping table in Notebook 2). It also provides latitude/longitude access rather than station IDs, making it simpler to query for the exact ten streaming cities. It is the recommended dataset for the "Building Realistic Weather Profiles" notebook because the data is already clean.

**WMO weather code to condition label mapping** (reference for notebooks):

| WMO codes | Our condition label |
|-----------|---------------------|
| 0 | Clear |
| 1, 2 | Sunny |
| 3 | Cloudy |
| 45, 48 | Foggy |
| 51, 53, 55, 56, 57 | Drizzle |
| 61, 63 | Rainy |
| 65, 66, 67 | Rainy (heavy) |
| 71, 73, 75, 77 | Snowy |
| 80, 81, 82 | Rainy |
| 85, 86 | Snowy |
| 95 | Stormy |
| 96, 99 | Hail |
| (sustained wind >= 40 km/h, no precip) | Windy |

---

### Dataset 3: NOAA Climate Data Online (CDO) — Monthly Normals

**URL**: `https://www.ncei.noaa.gov/cdo-web/api/v2/`
**License**: U.S. Government Works — public domain
**Format**: JSON
**Approximate size**: Negligible (monthly summary records, kilobytes per station)
**API key required**: Yes — free, instant registration at `https://www.ncei.noaa.gov/cdo-web/token`

**What it contains**: "Climate normals" are 30-year averages (current baseline: 1991–2020) published by NOAA. They represent what weather is typical for a given location and month. Fields include monthly mean temperature, monthly precipitation normal, heating/cooling degree days, and frost/freeze probabilities.

**Why it's useful for this project**: Normals are not raw data — they are already-computed statistical summaries. They answer the question "what is a realistic temperature for London in January?" without requiring any statistical computation. They serve as a fast-path baseline for the minion profile generator: if a full historical download is not yet complete, normals provide a defensible first approximation.

**How to download** (requires free API token):

```bash
# Monthly normals for New York station (GHCND:USW00094728), all months
curl -H "token: YOUR_TOKEN_HERE" \
  "https://www.ncei.noaa.gov/cdo-web/api/v2/data?datasetid=NORMAL_MLY&stationid=GHCND:USW00094728&startdate=2010-01-01&enddate=2010-12-01&limit=1000"
```

**When to use this dataset**: Use Dataset 3 as a validation cross-check in Notebook 4 and the quality-report DAG. After building profiles from GSOD or Open-Meteo, compare the computed monthly mean against the NOAA normal for that station. Large discrepancies indicate data quality issues.

---

## Part 2: Jupyter Notebook Specifications

All notebooks live in the Jupyter container at `apps/datascience/jupyter/`. The container already has `pandas`, `duckdb`, `pyarrow`, `minio`, and `boto3` installed via `apps/datascience/jupyter/requirements.txt`.

Notebooks should be stored in MinIO at `s3://notebooks/` so they persist across container restarts (the Jupyter container is stateless).

Each notebook begins with a **"Before You Start"** markdown cell explaining what the notebook does, what prior knowledge is assumed (none for Notebook 1), and what the reader will be able to do when finished.

---

### Notebook 1: Getting Started with Weather Data

**File**: `01_getting_started.ipynb`
**Estimated time**: 45–60 minutes
**Assumed knowledge**: Can run Python; has seen a pandas DataFrame before

**Learning Objectives**

By the end of this notebook the reader will be able to:
- Download a GSOD CSV file for a single weather station using Python's `requests` library
- Load the CSV into a pandas DataFrame and inspect its structure
- Identify and describe the most important columns (temperature, precipitation, wind)
- Compute basic descriptive statistics (mean, median, standard deviation, min, max)
- Save a dataset to MinIO using the `boto3` client

**Section and Cell Outline**

| Section | Cell type | Description |
|---------|-----------|-------------|
| 1.1 What is GSOD? | Markdown | Explain NOAA GSOD: who publishes it, what a "weather station" is (WMO network), why airport stations are reliable |
| 1.2 Setup | Code | Import `requests`, `pandas`, `io`, `boto3`; define MinIO connection constants (`endpoint_url`, `bucket`) |
| 1.3 Connect to MinIO | Code | Create `boto3` S3 client; verify connection by listing buckets; create `raw-weather` bucket if it does not exist |
| 1.4 Download GSOD for New York JFK | Code | `requests.get()` the JFK 2024 CSV URL; print HTTP status code; explain what a 200 response means |
| 1.5 Inspect raw bytes | Code | `pd.read_csv(io.StringIO(response.text))`; call `.head()`, `.shape`, `.dtypes` |
| 1.6 Column glossary | Markdown | Table explaining each column name, its meteorological meaning, and its unit. Explain NOAA's `9999.9` sentinel value for missing data |
| 1.7 Replace missing values | Code | `df.replace(9999.9, pd.NA)` and `df.replace(999.9, pd.NA)`; show before/after row counts with `.isna().sum()` |
| 1.8 Convert temperature to Celsius | Code | `df['TEMP_C'] = (df['TEMP'] - 32) * 5 / 9`; explain the formula; show sample rows |
| 1.9 Descriptive statistics | Code | `df[['TEMP_C', 'WDSP', 'PRCP']].describe()`; explain each statistic (mean, std, 25th percentile, etc.) |
| 1.10 What does the temperature distribution look like? | Code | `df['TEMP_C'].hist(bins=30)`; explain what a histogram is and what a bell curve means for climate |
| 1.11 Save to MinIO | Code | Upload the CSV bytes to `s3://raw-weather/gsod/2024/74486099999.csv` using `s3.put_object()` |
| 1.12 Summary | Markdown | Recap what was accomplished; link to Notebook 2 |

**Key pandas operations**: `pd.read_csv()`, `.head()`, `.dtypes`, `.describe()`, `.isna().sum()`, `.replace()`, `.hist()`
**Plots**: One histogram of daily mean temperature (Celsius) for the full year

---

### Notebook 2: Weather Data Cleaning and Munging

**File**: `02_cleaning_and_munging.ipynb`
**Estimated time**: 60–90 minutes
**Assumed knowledge**: Notebook 1 completed; understands DataFrames and basic pandas operations

**Learning Objectives**

By the end of this notebook the reader will be able to:
- Load raw GSOD data from MinIO for multiple stations
- Handle the three types of missing data in weather datasets: sentinel values, gaps, and instrument outages
- Normalize temperature data across stations that use different units
- Add a `month` column and group data by month for seasonal analysis
- Map numeric temperatures and WMO weather codes to our existing ten summary labels
- Write a cleaned Parquet file to MinIO

**Background: Why Weather Data Is Messy** (introductory markdown cell)

Weather data has three common quality problems that do not occur in most business datasets:

1. **Sentinel values**: NOAA uses `9999.9` to mean "this measurement was not taken." These are not outliers — they must be replaced with `NaN`, not filtered out, because they represent gaps not bad readings.
2. **Instrument calibration drift**: Temperature sensors age. A station may read consistently 0.5°C high for a period. This is why the FRSHTT quality flags exist.
3. **Station relocation**: A station that moves 10km can show a step-change in mean temperature with no climate signal. Station history records track this.

For this project (teaching purposes), we handle problem 1 fully and acknowledge 2 and 3 as known limitations.

**Section and Cell Outline**

| Section | Cell type | Description |
|---------|-----------|-------------|
| 2.1 Setup | Code | Import `pandas`, `numpy`, `boto3`; load all ten city CSV files from `s3://raw-weather/gsod/2024/` into a single DataFrame with a `city` column added |
| 2.2 Inspect combined dataset | Code | `.shape`, `.dtypes`, value counts for `STATION`; explain "long format" vs "wide format" |
| 2.3 Replace NOAA sentinel values | Code | Replace `9999.9`, `999.9`, `99.99`, `99` (various column-specific sentinels); `.isna().sum()` per column per city |
| 2.4 Visualize missingness | Code | `df.isna().mean().plot(kind='bar')`; explain that >20% missingness in a column makes it unreliable |
| 2.5 Impute missing temperature values | Code | `df['TEMP_C'].fillna(df.groupby(['city', 'month'])['TEMP_C'].transform('mean'))`; explain forward-fill vs mean-fill vs drop |
| 2.6 Add derived time columns | Code | `df['month'] = pd.to_datetime(df['DATE']).dt.month`; `df['season']` using a dictionary map; explain meteorological seasons vs calendar seasons |
| 2.7 Temperature unit normalization | Code | Add `TEMP_C`, `MAX_C`, `MIN_C` columns; assert no values outside physically plausible range (-89.2°C to +56.7°C — world record extremes) |
| 2.8 Map temperatures to Summary labels | Code | Define a `temp_to_summary(temp_c)` function using the existing classification thresholds; apply with `.apply()`; show value counts |
| 2.9 Map WMO codes to condition labels | Code | Build a dictionary from the WMO mapping table in Part 1; apply with `.map()`; handle unmapped codes with `fillna('Clear')` |
| 2.10 Validate label consistency | Code | Assert that rows labelled "Freezing" have `TEMP_C < 0`; assert "Scorching" rows have `TEMP_C >= 35`; print any violations |
| 2.11 Write cleaned Parquet to MinIO | Code | `df.to_parquet()` with PyArrow; upload to `s3://clean-weather/gsod/all_cities_2024.parquet`; explain why Parquet is better than CSV for analytics |
| 2.12 Summary | Markdown | What was cleaned, what was lost, what assumptions were made |

**Key pandas operations**: `pd.concat()`, `.groupby().transform()`, `.fillna()`, `.apply()`, `.map()`, `.to_parquet()`, `.dt.month`
**Plots**: Bar chart of missingness percentage per column

**The `temp_to_summary()` function** (reference implementation for the notebook):

```python
def temp_to_summary(temp_c):
    """
    Map a Celsius temperature to one of the ten WeatherForecast summary labels.
    Thresholds match the existing color-coded temperature classification used
    across weather-app and weatherstream-app.
    """
    if temp_c is None or pd.isna(temp_c):
        return "Cool"  # safe fallback
    if temp_c < -10:
        return "Freezing"
    elif temp_c < 0:
        return "Bracing"
    elif temp_c < 5:
        return "Chilly"
    elif temp_c < 15:
        return "Cool"
    elif temp_c < 20:
        return "Mild"
    elif temp_c < 25:
        return "Warm"
    elif temp_c < 30:
        return "Balmy"
    elif temp_c < 35:
        return "Hot"
    elif temp_c < 42:
        return "Sweltering"
    else:
        return "Scorching"
```

Note for the notebook author: these thresholds are deliberately narrower than the five-bucket UI color scheme (which uses `< 0`, `0-15`, `15-25`, `25-35`, `>= 35`). The ten summary labels subdivide those buckets further. The mapping above must be kept in sync with `MinionSchedulerService.cs` if the backend ever adopts these labels conditionally.

---

### Notebook 3: Visualizing Weather Patterns

**File**: `03_visualizing_patterns.ipynb`
**Estimated time**: 60–75 minutes
**Assumed knowledge**: Notebooks 1 and 2 completed; cleaned Parquet file exists in MinIO

**Learning Objectives**

By the end of this notebook the reader will be able to:
- Load a Parquet file from MinIO and query it with DuckDB
- Create a monthly temperature time-series plot for a single city
- Overlay multiple cities on one plot to compare climates
- Build a heatmap showing average temperature by city and month
- Interpret a box plot as a summary of a temperature distribution
- Explain what "seasonal cycle" means and why it differs by hemisphere

**Background: Reading Weather Patterns in Data** (introductory markdown cell)

Weather and climate are often confused. **Weather** is what happens on a specific day. **Climate** is the pattern of what typically happens across many years. When we plot the average temperature for each month over five years of data, we are looking at climate — the underlying signal that the minion profiles should reproduce.

Key patterns to look for:
- **Seasonal cycle**: Temperature rises in summer, falls in winter. Northern and southern hemisphere cities are offset by six months.
- **Temperature range**: Continental cities (Berlin, Toronto) have a larger difference between summer and winter than coastal or tropical cities (Mumbai, Sydney).
- **Interannual variability**: Year-to-year variation around the seasonal mean. A wide spread in a box plot indicates high variability.

**Section and Cell Outline**

| Section | Cell type | Description |
|---------|-----------|-------------|
| 3.1 Setup | Code | Import `pandas`, `matplotlib.pyplot`, `seaborn`, `duckdb`; connect DuckDB to the MinIO-backed Parquet file via `httpfs` extension |
| 3.2 Load data with DuckDB | Code | `duckdb.sql("SELECT * FROM 's3://clean-weather/gsod/all_cities_2024.parquet'")`; explain why DuckDB can query S3 directly without loading into memory first |
| 3.3 Monthly average temperature per city | Code | SQL `GROUP BY city, month`; `pivot_table()`; line plot with one line per city; label axes with units |
| 3.4 Interpret the seasonal cycle | Markdown | Explain northern vs southern hemisphere offset (Sydney summer = January; Berlin summer = July); explain why Mumbai has a small seasonal cycle (tropical climate) |
| 3.5 Temperature distribution per city | Code | Box plot with `city` on x-axis, `TEMP_C` on y-axis; explain box plot anatomy (median, IQR, whiskers, outliers) |
| 3.6 City vs city climate comparison | Code | Horizontal bar chart of annual mean temperature per city, sorted descending; annotate with city name |
| 3.7 Monthly temperature heatmap | Code | `seaborn.heatmap()` with cities as rows, months as columns, mean temperature as value; use a diverging colormap (`coolwarm`) centered at 15°C |
| 3.8 Precipitation pattern | Code | Bar chart of monthly total precipitation (mm) for one city; explain what "rainy season" looks like in Mumbai (monsoon) vs Berlin (distributed) |
| 3.9 Summary label distribution per city | Code | Stacked bar chart showing proportion of days with each summary label per city; helps validate that Mumbai rarely gets "Freezing" |
| 3.10 Export plots to MinIO | Code | `fig.savefig()` to a bytes buffer; upload to `s3://analytics/plots/` |
| 3.11 Summary | Markdown | Key findings; prompt reader to ask: "Does our minion data show the same seasonal patterns?" — answered in Notebook 4 |

**Key operations**: `duckdb.sql()`, `pd.pivot_table()`, `matplotlib` line/bar/box plots, `seaborn.heatmap()`
**Plots**:
1. Line plot — monthly mean temperature, all 10 cities overlaid (primary insight plot)
2. Box plot — temperature distribution per city (shows variability)
3. Heatmap — city x month mean temperature (most visually impactful)
4. Stacked bar chart — summary label distribution per city (direct validation of label quality)

---

### Notebook 4: Building Realistic Weather Profiles

**File**: `04_building_profiles.ipynb`
**Estimated time**: 90–120 minutes
**Assumed knowledge**: Notebooks 1–3 completed; understanding of mean and standard deviation

**Learning Objectives**

By the end of this notebook the reader will be able to:
- Explain what a "statistical profile" is and how it differs from a lookup table
- Compute per-city, per-month Gaussian parameters (mean, standard deviation) for temperature
- Compute conditional probability distributions for summary labels given month and city
- Write a `generate_forecast(city, month)` function that draws from these distributions
- Compare the output of that function against the current uniform-random minion data
- Serialize the final profiles to JSON and Parquet in MinIO

**Background: From Raw Data to a Generative Model** (introductory markdown cell)

A "generative model" is a set of rules that, when followed, produces new data that looks like it came from the same source as the training data. For weather, the simplest useful generative model is:

> "Temperature in London in January is normally distributed with mean 5.2°C and standard deviation 3.1°C. Given that temperature, there is a 40% chance of 'Rainy', a 25% chance of 'Cloudy', a 15% chance of 'Drizzle', and so on."

This is far more realistic than "pick any temperature from -20 to 55°C at random." It will not capture every nuance of real weather (that would require a numerical weather prediction model), but it will produce data that passes a basic statistical sanity check.

**Section and Cell Outline**

| Section | Cell type | Description |
|---------|-----------|-------------|
| 4.1 Setup | Code | Import `pandas`, `numpy`, `scipy.stats`, `json`, `boto3`; load cleaned Parquet from MinIO |
| 4.2 Compute monthly temperature statistics per city | Code | `groupby(['city', 'month'])['TEMP_C'].agg(['mean', 'std'])`; rename columns; handle cities with low std (tropical) by setting a floor of 1.0°C std |
| 4.3 Visualize the Gaussian fit | Code | For two cities (London and Sydney), plot the empirical histogram of January temperatures overlaid with the fitted Gaussian curve; explain visually why normal distribution is a reasonable model |
| 4.4 Sanity-check against NOAA normals | Code | Load Dataset 3 (NOAA CDO normals) for comparison; show a table of computed mean vs NOAA normal; flag months where the difference exceeds 2°C |
| 4.5 Compute conditional summary label probabilities | Code | `groupby(['city', 'month', 'summary_label']).size() / groupby(['city', 'month']).size()`; result is a DataFrame of probabilities summing to 1.0 per city-month |
| 4.6 Handle sparse cells | Code | Some cities may have zero "Hail" days; explain why a zero probability is problematic (it means the event can never be generated); apply Laplace smoothing: add 0.01 to each count before normalizing |
| 4.7 Build the profile dictionary | Code | Construct a nested dictionary: `profiles[city][month] = {'temp_mean': float, 'temp_std': float, 'label_probs': {label: prob, ...}}`; pretty-print one entry |
| 4.8 Write a `generate_forecast()` function | Code | `def generate_forecast(city, month): temp = np.random.normal(mean, std); label = np.random.choice(labels, p=probs); return {'TemperatureC': round(temp), 'Summary': label}`; show 10 sample outputs |
| 4.9 Compare against current minion output | Code | Generate 1000 samples from `generate_forecast('London', 1)` and 1000 samples from the current uniform random (`np.random.randint(-20, 55)`); plot both distributions side by side; compute mean absolute deviation from the NOAA normal |
| 4.10 Serialize profiles to JSON | Code | `json.dumps(profiles, indent=2)`; upload to `s3://analytics/profiles/weather_profiles_v1.json` |
| 4.11 Serialize profiles to Parquet | Code | Flatten the dictionary to a DataFrame; write to `s3://analytics/profiles/weather_profiles_v1.parquet` for SQL querying |
| 4.12 Next steps | Markdown | Explain how `MinionSchedulerService.cs` could be extended to load these profiles at startup; describe the `WeatherProfileService` concept (out of scope for this notebook but flagged for the engineering team) |

**Key operations**: `groupby().agg()`, `scipy.stats.norm.pdf()`, `np.random.normal()`, `np.random.choice()`, `json.dumps()`, `.to_parquet()`
**Plots**:
1. Histogram with Gaussian overlay for two cities (shows goodness of fit)
2. Side-by-side comparison: current minion distribution vs profile-based distribution for one city-month

**Output artifact**: `s3://analytics/profiles/weather_profiles_v1.json`

This JSON file is the primary deliverable of the data science initiative. The next engineering phase (out of scope for this spec) would wire it into `MinionSchedulerService.cs` as a `WeatherProfileService`.

---

## Part 3: Airflow DAG Specifications

All DAGs live at `apps/datascience/airflow/dags/`. The Airflow container (`apps/datascience/airflow/Containerfile`) uses `apache/airflow:slim-2.10.4-python3.11` with `duckdb`, `duckdb-engine`, and `minio` pre-installed.

**Convention**: DAG files use snake_case, prefixed with their domain. Connections are configured via Airflow UI or environment variables. DAG IDs follow the pattern `weather_<purpose>`.

**Airflow connections required** (configure in Airflow UI under Admin > Connections):

| Connection ID | Type | Used by |
|---------------|------|---------|
| `minio_default` | S3 / Generic | DAGs 1, 2, 3 |
| `postgres_weather` | Postgres | DAG 2, DAG 3 |
| `kafka_weather` | Kafka (generic hook) | DAG 2 |

---

### DAG 1: `weather_dataset_ingestion`

**File**: `apps/datascience/airflow/dags/weather_dataset_ingestion.py`
**Purpose**: Periodically check whether fresh GSOD and Open-Meteo data exists in MinIO; download if absent or stale
**Schedule**: `0 3 * * *` — daily at 03:00 UTC (outside peak usage hours)
**Max active runs**: 1 (prevents overlapping downloads)
**Tags**: `ingestion`, `gsod`, `open-meteo`, `minio`

**Design principle**: Always check MinIO before downloading. The check is cheap (S3 HEAD request); the download may be large. This avoids re-downloading unchanged data and keeps the pipeline idempotent — it can be re-run at any time without side effects.

**Tasks**

| Task ID | Operator | Description |
|---------|----------|-------------|
| `check_minio_buckets` | `PythonOperator` | Verify that `raw-weather`, `clean-weather`, and `analytics` buckets exist; create them if absent using `boto3.create_bucket()`. This is a pre-flight check — downstream tasks assume the buckets exist. |
| `check_gsod_files` | `PythonOperator` | For each of the 10 city station IDs, call `s3.head_object(Bucket='raw-weather', Key=f'gsod/{year}/{station_id}.csv')`. Push a list of missing station IDs to XCom as `missing_stations`. |
| `download_gsod` | `PythonOperator` | For each station in XCom `missing_stations`, download from `https://www.ncei.noaa.gov/data/global-summary-of-the-day/access/{year}/{station_id}.csv` and upload to MinIO. Log bytes downloaded per file. Skip stations that return HTTP 404 (station may not have data for that year). |
| `check_openmeteo_files` | `PythonOperator` | For each of the 10 cities, check `s3://raw-weather/open-meteo/{year}/{city_slug}.json`. Push missing city slugs to XCom. |
| `download_openmeteo` | `PythonOperator` | For each city in XCom, call Open-Meteo archive API with `daily` parameters matching Notebook 2's column set. Respect a 1-second sleep between requests to avoid hitting the free-tier rate limit (600 requests/minute). Upload JSON to MinIO. |
| `log_ingestion_summary` | `PythonOperator` | Read XCom from both download tasks; write a summary record to `s3://analytics/ingestion-log/{date}.json` with counts of files downloaded, skipped (already existed), and failed. |

**Task dependencies**:

```
check_minio_buckets
    ├── check_gsod_files → download_gsod ──────────┐
    └── check_openmeteo_files → download_openmeteo ─┤
                                                     └── log_ingestion_summary
```

**Error handling**:

- HTTP errors on NOAA download: retry 3 times with 30-second backoff; after 3 failures, mark the individual station as failed but continue the DAG (do not fail the entire run).
- HTTP 429 from Open-Meteo: exponential backoff starting at 60 seconds; log a warning.
- MinIO connection failure: mark the task as failed and alert (fail the entire DAG — no point proceeding without storage).
- All download tasks use `execution_timeout=timedelta(minutes=15)` to prevent hung downloads from blocking the scheduler.

**Documentation note for new users**: This DAG does not process or clean data — it only moves it from external sources to MinIO. Think of it as an "acquire" step. The raw files are immutable once written; if data quality issues are found later, the cleaning notebooks fix them without re-downloading. This separation between acquisition and transformation is a core data engineering principle called ELT (Extract-Load-Transform).

---

### DAG 2: `weather_kafka_to_duckdb`

**File**: `apps/datascience/airflow/dags/weather_kafka_to_duckdb.py`
**Purpose**: Poll Kafka for new `WeatherForecasts` CDC events and sink them into a DuckDB table in MinIO for analytical querying
**Schedule**: `*/15 * * * *` — every 15 minutes
**Max active runs**: 1
**Tags**: `kafka`, `cdc`, `duckdb`, `analytics`

**Background for new users** (in the DAG docstring): Debezium captures every INSERT, UPDATE, and DELETE on the `WeatherForecasts` PostgreSQL table and publishes it to the Kafka topic `weather.public.WeatherForecasts` in Avro format. Each Kafka message contains the full row after the change (the "after" payload) plus metadata about the operation type (`c` = create, `u` = update, `d` = delete, `r` = read/snapshot). This DAG reads those messages and writes them into a DuckDB table so that notebooks and the quality-report DAG can query the live minion output without touching the production PostgreSQL database.

**Why DuckDB and not PostgreSQL directly?** DuckDB is an analytical database optimized for column-scan queries (aggregations, GROUP BY, window functions). PostgreSQL is an OLTP database optimized for row-level reads and writes. By mirroring data to DuckDB, we keep heavy analytical queries off the production database. DuckDB also integrates natively with Parquet files in MinIO, making it easy to JOIN historical weather data (from DAG 1) against live minion output.

**Tasks**

| Task ID | Operator | Description |
|---------|----------|-------------|
| `poll_kafka_topic` | `PythonOperator` | Use `confluent-kafka` consumer with group ID `airflow-duckdb-sync`; poll `weather.public.WeatherForecasts` topic for up to 500 messages or 60 seconds, whichever comes first. Deserialize Avro payload using Schema Registry URL. Push raw records to XCom as a list of dicts. |
| `upsert_to_duckdb` | `PythonOperator` | Load `s3://analytics/duckdb/weather_forecasts.duckdb`; perform INSERT OR REPLACE for `op=c/u/r` operations; perform DELETE WHERE id=... for `op=d` operations. Use `duckdb.connect()` with the `httpfs` extension to read/write from MinIO directly. Commit offset to Kafka only after DuckDB write succeeds. |
| `log_sync_stats` | `PythonOperator` | Write stats (records inserted, updated, deleted, Kafka lag estimate) to `s3://analytics/sync-log/{date}/{run_id}.json` |

**Task dependencies**:

```
poll_kafka_topic → upsert_to_duckdb → log_sync_stats
```

**DuckDB schema** (created on first run if absent):

```sql
CREATE TABLE IF NOT EXISTS weather_forecasts (
    id          INTEGER PRIMARY KEY,
    date        DATE NOT NULL,
    temperature_c INTEGER NOT NULL,
    summary     VARCHAR,
    ingested_at TIMESTAMP DEFAULT current_timestamp,
    kafka_offset BIGINT,
    op          VARCHAR(1)  -- 'c', 'u', 'd', 'r'
);
```

**Error handling**:

- Kafka consumer timeout (no messages in 60s): treat as success — no new events is a valid state; log "0 records polled."
- Schema Registry unreachable: fail the task; do not commit Kafka offset; retry up to 3 times. The consumer group will re-poll from the last committed offset on the next run.
- DuckDB write failure: do not commit Kafka offset; this ensures the next poll will re-read the same messages (at-least-once delivery guarantee).
- XCom size limit: if more than 500 records are received in one poll, write them to a temporary file in MinIO instead of XCom, and pass the file path via XCom instead.

**Important offset management note**: The Kafka consumer group `airflow-duckdb-sync` must commit offsets only after a successful DuckDB write. If the DAG fails mid-run, re-running it will re-process messages from the last committed offset. This may cause duplicate processing of some records — which is safe because the DuckDB upsert is idempotent (INSERT OR REPLACE on primary key).

**Documentation note**: This DAG creates a queryable mirror of minion output. After this DAG has run for a few days, Notebook 4 Section 4.9 can compare the real minion distribution against the profile-based one.

---

### DAG 3: `weather_quality_report`

**File**: `apps/datascience/airflow/dags/weather_quality_report.py`
**Purpose**: Daily report comparing minion-generated forecast data against historical climate norms, surfacing statistical anomalies
**Schedule**: `0 6 * * *` — daily at 06:00 UTC (runs after DAG 1 at 03:00 has finished ingesting fresh data)
**Max active runs**: 1
**Tags**: `quality`, `reporting`, `analytics`
**Dependency**: Requires DAG 1 to have run at least once (GSOD files must exist in MinIO). Handled via Airflow dataset sensors or a simple `ExternalTaskSensor` on `weather_dataset_ingestion`.

**Purpose explained for new users**: After minions have been running for several days, we want to know: "Is the data they generate realistic?" This DAG runs a set of statistical checks every morning and writes a report. It does not fix anything — it only observes and reports. Think of it as a weather quality auditor.

**Tasks**

| Task ID | Operator | Description |
|---------|----------|-------------|
| `wait_for_ingestion` | `ExternalTaskSensor` | Wait up to 2 hours for the previous day's `weather_dataset_ingestion` DAG run to complete successfully. This ensures fresh GSOD data exists before running comparisons. |
| `load_historical_norms` | `PythonOperator` | Query the cleaned GSOD Parquet from MinIO via DuckDB: compute monthly mean and std for each of the 10 cities. Write to an in-memory dict. |
| `load_minion_output` | `PythonOperator` | Query DuckDB `weather_forecasts` table for forecasts created in the past 24 hours by minions (identifiable by `Summary` containing `[Minion:`). Compute mean temperature and summary label distribution. |
| `compute_deviation_scores` | `PythonOperator` | For each city present in minion output: compute z-score of minion mean temperature vs. historical norm for that month. Flag any city-month pair where `abs(z_score) > 2.0` as an anomaly. A z-score > 2 means the minion output is more than 2 standard deviations from the historical mean — statistically unusual. |
| `check_label_consistency` | `PythonOperator` | For each minion forecast, verify that the `Summary` label is consistent with `TemperatureC` using the `temp_to_summary()` thresholds from Notebook 2. Count and report violations (e.g., a "Scorching" label on a 12°C forecast). |
| `write_report` | `PythonOperator` | Assemble a JSON report with sections: metadata (run date, record counts), temperature deviation scores, label consistency violations, and an overall quality score (0–100, computed as: 100 minus 10 per anomaly minus 2 per label violation, floor 0). Write to `s3://analytics/quality-reports/{date}.json`. |
| `log_report_summary` | `PythonOperator` | Print the quality score and top 3 anomalies to the Airflow task log. If quality score < 50, mark the task with a warning (yellow in Airflow UI) using `AirflowSkipException` with a descriptive message. Do not fail the DAG — low quality is informational. |

**Task dependencies**:

```
wait_for_ingestion
    → load_historical_norms ──┐
    → load_minion_output ──────┤
                               → compute_deviation_scores ─┐
                               → check_label_consistency ──┤
                                                           → write_report
                                                               → log_report_summary
```

**Report schema** (written to `s3://analytics/quality-reports/{YYYY-MM-DD}.json`):

```json
{
  "report_date": "2026-03-26",
  "minion_forecast_count_24h": 142,
  "cities_observed": ["New York", "London"],
  "temperature_deviations": [
    {
      "city": "London",
      "month": 3,
      "historical_mean_c": 8.2,
      "historical_std_c": 3.1,
      "minion_mean_c": 31.5,
      "z_score": 7.5,
      "status": "ANOMALY"
    }
  ],
  "label_violations": [
    {
      "forecast_id": 1234,
      "temperature_c": 12,
      "summary": "Scorching",
      "expected_summary": "Cool",
      "violation_type": "label_too_hot"
    }
  ],
  "quality_score": 70,
  "notes": "2 temperature anomalies, 1 label violation detected."
}
```

**Error handling**:

- If DuckDB has no minion forecasts for the past 24 hours: write a report with `minion_forecast_count_24h: 0` and quality score 100 (no data means no violations); log a notice.
- If GSOD Parquet does not exist (DAG 1 has never run): fail `load_historical_norms` with a clear message: "Run weather_dataset_ingestion DAG first."

---

## Part 4: MinIO Bucket Structure

MinIO is S3-compatible. All paths below use the convention `s3://bucket-name/prefix/` to match boto3 and DuckDB `httpfs` notation.

**Bucket naming convention**: All lowercase, hyphenated, no underscores (S3 DNS-compatible naming). Buckets are created by the `check_minio_buckets` task in DAG 1 on first run.

---

### Bucket: `raw-weather`

Immutable raw data as downloaded from external sources. Nothing in this bucket is ever modified after writing. If a re-download is needed, the old file is overwritten with the new one (same key), making the latest download the canonical raw record.

```
raw-weather/
├── gsod/
│   ├── 2023/
│   │   ├── 74486099999.csv          # New York JFK, full year
│   │   ├── 03772099999.csv          # London Heathrow
│   │   └── ...                      # one file per station per year
│   └── 2024/
│       └── ...
├── open-meteo/
│   ├── 2023/
│   │   ├── new-york.json            # city slug, full year daily data
│   │   ├── london.json
│   │   └── ...
│   └── 2024/
│       └── ...
└── noaa-normals/
    └── isd-history.csv              # station master list (re-downloaded monthly)
```

---

### Bucket: `clean-weather`

Processed, validated, and unit-normalized data derived from `raw-weather`. Written by notebooks (manually) and eventually by a cleaning DAG. Files here are Parquet (columnar, compressed, fast for DuckDB). May be regenerated if cleaning logic changes — not treated as immutable.

```
clean-weather/
├── gsod/
│   ├── all_cities_2023.parquet      # all 10 cities, one year, cleaned
│   └── all_cities_2024.parquet
├── open-meteo/
│   ├── all_cities_2023.parquet
│   └── all_cities_2024.parquet
└── combined/
    └── all_cities_all_years.parquet  # union of all years, for profile building
```

---

### Bucket: `analytics`

Derived outputs from analytical processes. Subdivided by type. These files are consumed by the quality-report DAG, the profile-building notebook, and eventually by the application layer.

```
analytics/
├── profiles/
│   ├── weather_profiles_v1.json     # primary output of Notebook 4
│   └── weather_profiles_v1.parquet  # same data, SQL-queryable
├── duckdb/
│   └── weather_forecasts.duckdb    # live mirror of PostgreSQL WeatherForecasts (DAG 2)
├── quality-reports/
│   ├── 2026-03-26.json
│   ├── 2026-03-27.json
│   └── ...
├── plots/
│   ├── monthly_temp_all_cities.png  # from Notebook 3
│   └── ...
├── ingestion-log/
│   ├── 2026-03-26.json              # DAG 1 run summary
│   └── ...
└── sync-log/
    ├── 2026-03-26/
    │   ├── run_id_abc123.json       # DAG 2 run summary
    │   └── ...
    └── ...
```

---

### Bucket: `notebooks`

Notebook `.ipynb` files persisted to MinIO so they survive container restarts. Jupyter should be configured to use this bucket as its working directory via the `s3contents` Jupyter extension (requires adding `s3contents` to `apps/datascience/jupyter/requirements.txt`).

```
notebooks/
├── 01_getting_started.ipynb
├── 02_cleaning_and_munging.ipynb
├── 03_visualizing_patterns.ipynb
└── 04_building_profiles.ipynb
```

---

## Dependencies and Agent Coordination

| Concern | Action required | Owner domain |
|---------|-----------------|--------------|
| `scipy` not in Jupyter requirements | Add `scipy matplotlib seaborn` to `apps/datascience/jupyter/requirements.txt` | devops |
| `confluent-kafka` not in Airflow image | Add `confluent-kafka apache-airflow-providers-apache-kafka` to Airflow `Containerfile` | devops |
| `s3contents` for notebook persistence | Add `s3contents` to Jupyter `requirements.txt`; configure `jupyter_server_config.py` | devops |
| Airflow connections | Add `minio_default`, `postgres_weather`, `kafka_weather` connections in Airflow UI or via env vars | devops / ops |
| MinIO credentials | Ensure MinIO endpoint, access key, and secret key are available to both Airflow and Jupyter containers as env vars (`MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`) | devops |
| DuckDB `httpfs` extension | Requires `INSTALL httpfs; LOAD httpfs;` at DuckDB connection time in both notebooks and DAGs | data engineering |
| No schema change to `WeatherForecast` | This initiative is read-only with respect to the production data model — no EF Core migration needed | n/a |
| CDC not affected | No new tables; DAG 2 consumes from the existing `weather.public.WeatherForecasts` topic — no Debezium reconfiguration needed | kafka |

---

## Out of Scope

The following are explicitly excluded from this specification. They represent the natural next phase once the profiles exist:

- Wiring `weather_profiles_v1.json` into `MinionSchedulerService.cs` (a `WeatherProfileService` that loads profiles at startup and exposes a `GenerateForecast(city, month)` method)
- Adding `Location` to the `WeatherForecast` model (required before profiles can be city-specific in production)
- Real-time streaming profile updates (the profile is a static artifact; versioned files in MinIO is the v1 approach)
- Hourly forecast granularity (current model is `DateOnly` — a separate spec is needed to add hourly records)
- Public-facing quality dashboard (the quality-report JSON is internal only in this spec)
- Automated retraining of profiles when new GSOD data arrives (DAG trigger chaining)
- Data lineage tracking (which version of the profiles generated which forecasts)

---

## Open Questions

The following decisions require stakeholder input before implementation begins:

1. **City scope for profiles**: The streaming events already reference 10 specific cities, but the `WeatherForecast` model has no `Location` field. Should profiles be city-specific (requiring a model change before they can be used in production), or should a single "global average" profile be built first as an interim solution?

2. **Historical window**: How many years of GSOD data should the profiles be built from? More years produces more stable statistics but increases download time and storage. A 5-year window (2020–2024) is a reasonable starting point — is that acceptable?

3. **Notebook execution environment**: Should notebooks be run manually by developers, or scheduled by Airflow (using `PapermillOperator`)? The current spec assumes manual execution for the learning-focused notebooks (1–3) and manual one-time execution for Notebook 4. If automated re-execution is desired, the spec for Notebook 4 changes significantly.

4. **MinIO access from browser**: The Jupyter container currently requires direct network access to MinIO. Is MinIO exposed through Traefik, or should Jupyter access it via a direct internal hostname? (CORS and routing implications if the notebook UI is accessed through the browser.)

5. **Profile versioning strategy**: When new data is available and profiles are regenerated, should the old `weather_profiles_v1.json` be overwritten or kept alongside a `v2`? Overwriting is simpler; versioning allows rollback if the new profile performs worse.
