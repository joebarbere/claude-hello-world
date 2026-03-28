"""
minio_helper.py
===============
Reusable MinIO utilities for both Jupyter notebooks and Airflow DAGs.

This module wraps the official minio Python SDK and provides three things:
  1. Checking whether an object already exists (to avoid re-downloading)
  2. Uploading a local file (or an in-memory buffer) to a bucket
  3. Downloading an object and returning it as a pandas DataFrame

Design decisions
----------------
- Uses the minio SDK directly (not boto3) because it ships in both
  container images and its API is simpler for object-level work.
- All functions accept an optional `client` argument so callers can
  inject a pre-configured client (useful in tests and Airflow tasks
  where the client is created once and reused).
- Bucket auto-creation: buckets are created if they do not yet exist,
  which removes ordering friction during first-run setup.

Usage in Jupyter
----------------
    from minio_helper import get_client, object_exists, upload_file, read_csv

    client = get_client()
    if not object_exists(client, "weather-raw", "ghcn/USW00094728.csv"):
        upload_file(client, "weather-raw", "ghcn/USW00094728.csv", "/tmp/USW00094728.csv")

    df = read_csv(client, "weather-raw", "ghcn/USW00094728.csv")

Usage in Airflow (inside a PythonOperator callable)
----------------------------------------------------
    from minio_helper import get_client, object_exists, upload_file

    def _upload(**context):
        client = get_client()
        upload_file(client, "weather-raw", "ghcn/USW00094728.csv", "/tmp/USW00094728.csv")
"""

import io
import logging
import os

import pandas as pd
from minio import Minio
from minio.error import S3Error

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Default connection settings
# All values can be overridden via environment variables so the same code
# works whether it runs on the host, in Jupyter, or in the Airflow container.
# ---------------------------------------------------------------------------
_DEFAULT_ENDPOINT = os.environ.get("MINIO_ENDPOINT", "localhost:9000")
_DEFAULT_ACCESS_KEY = os.environ.get("MINIO_ACCESS_KEY", "minioadmin")
_DEFAULT_SECRET_KEY = os.environ.get("MINIO_SECRET_KEY", "minioadmin")


def get_client(
    endpoint: str = _DEFAULT_ENDPOINT,
    access_key: str = _DEFAULT_ACCESS_KEY,
    secret_key: str = _DEFAULT_SECRET_KEY,
    secure: bool = False,
) -> Minio:
    """
    Return a connected Minio client.

    Parameters
    ----------
    endpoint : str
        Host:port of the MinIO server (no http:// prefix).
    access_key : str
        MinIO access key (username).
    secret_key : str
        MinIO secret key (password).
    secure : bool
        Use TLS. False for the local dev environment.

    Returns
    -------
    Minio
        A configured Minio client instance.
    """
    log.debug("Creating MinIO client for endpoint=%s", endpoint)
    return Minio(endpoint, access_key=access_key, secret_key=secret_key, secure=secure)


def ensure_bucket(client: Minio, bucket: str) -> None:
    """
    Create the bucket if it does not exist.

    Parameters
    ----------
    client : Minio
        A connected Minio client.
    bucket : str
        Bucket name to ensure exists.
    """
    if not client.bucket_exists(bucket):
        client.make_bucket(bucket)
        log.info("Created bucket: %s", bucket)
    else:
        log.debug("Bucket already exists: %s", bucket)


def object_exists(client: Minio, bucket: str, object_name: str) -> bool:
    """
    Return True if the object already exists in the bucket.

    This is used to implement a 'MinIO-first' check before downloading
    a dataset from the internet — if the file is already stored, skip
    the download entirely.

    Parameters
    ----------
    client : Minio
        A connected Minio client.
    bucket : str
        Bucket name to check.
    object_name : str
        Full object key (path) inside the bucket, e.g. "ghcn/station.csv".

    Returns
    -------
    bool
        True if the object exists, False otherwise.
    """
    try:
        # stat_object raises S3Error with code 'NoSuchKey' if missing
        client.stat_object(bucket, object_name)
        log.debug("Object exists: %s/%s", bucket, object_name)
        return True
    except S3Error as err:
        if err.code in ("NoSuchKey", "NoSuchBucket"):
            log.debug("Object not found: %s/%s", bucket, object_name)
            return False
        # Any other S3 error (permissions, etc.) is re-raised
        raise


def upload_file(
    client: Minio,
    bucket: str,
    object_name: str,
    file_path: str,
    content_type: str = "application/octet-stream",
) -> None:
    """
    Upload a local file to MinIO.

    The bucket is created automatically if it does not exist.

    Parameters
    ----------
    client : Minio
        A connected Minio client.
    bucket : str
        Destination bucket name.
    object_name : str
        Destination key inside the bucket, e.g. "ghcn/USW00094728.csv".
    file_path : str
        Absolute path to the local file to upload.
    content_type : str
        MIME type stored as object metadata.

    Raises
    ------
    FileNotFoundError
        If file_path does not exist on disk.
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Local file not found: {file_path}")

    ensure_bucket(client, bucket)

    file_size = os.path.getsize(file_path)
    log.info(
        "Uploading %s (%d bytes) → %s/%s",
        file_path,
        file_size,
        bucket,
        object_name,
    )

    client.fput_object(
        bucket,
        object_name,
        file_path,
        content_type=content_type,
    )
    log.info("Upload complete: %s/%s", bucket, object_name)


def upload_dataframe(
    client: Minio,
    bucket: str,
    object_name: str,
    df: pd.DataFrame,
    file_format: str = "csv",
) -> None:
    """
    Write a pandas DataFrame directly to MinIO without writing a local file.

    Supported formats: "csv" and "parquet".
    Parquet is preferred for larger datasets because it is columnar,
    compressed, and preserves dtypes exactly.

    Parameters
    ----------
    client : Minio
        A connected Minio client.
    bucket : str
        Destination bucket name.
    object_name : str
        Destination key, e.g. "processed/daily_summary.parquet".
    df : pd.DataFrame
        DataFrame to serialize and upload.
    file_format : str
        "csv" or "parquet".
    """
    ensure_bucket(client, bucket)

    buf = io.BytesIO()

    if file_format == "parquet":
        # pyarrow must be installed (it is in both container images)
        df.to_parquet(buf, index=False, engine="pyarrow")
        content_type = "application/octet-stream"
    elif file_format == "csv":
        # Write CSV as UTF-8 bytes
        df.to_csv(buf, index=False)
        content_type = "text/csv"
    else:
        raise ValueError(f"Unsupported file_format: {file_format!r}. Use 'csv' or 'parquet'.")

    buf.seek(0)
    data_size = buf.getbuffer().nbytes

    log.info(
        "Uploading DataFrame (%d rows, %d bytes) → %s/%s",
        len(df),
        data_size,
        bucket,
        object_name,
    )

    client.put_object(
        bucket,
        object_name,
        buf,
        length=data_size,
        content_type=content_type,
    )
    log.info("Upload complete: %s/%s", bucket, object_name)


def read_csv(
    client: Minio,
    bucket: str,
    object_name: str,
    **read_csv_kwargs,
) -> pd.DataFrame:
    """
    Download an object from MinIO and parse it as a CSV into a DataFrame.

    The file is streamed into memory — no local temp file is written.

    Parameters
    ----------
    client : Minio
        A connected Minio client.
    bucket : str
        Source bucket name.
    object_name : str
        Object key inside the bucket.
    **read_csv_kwargs
        Any keyword arguments accepted by pandas.read_csv().
        Example: parse_dates=["DATE"], dtype={"STATION": str}

    Returns
    -------
    pd.DataFrame
        Parsed DataFrame.

    Raises
    ------
    S3Error
        If the object does not exist or cannot be retrieved.
    """
    log.info("Reading CSV from MinIO: %s/%s", bucket, object_name)
    response = client.get_object(bucket, object_name)
    try:
        buf = io.BytesIO(response.read())
    finally:
        # Always close and release the connection
        response.close()
        response.release_conn()

    df = pd.read_csv(buf, **read_csv_kwargs)
    log.info("Loaded %d rows, %d columns", len(df), len(df.columns))
    return df


def read_parquet(
    client: Minio,
    bucket: str,
    object_name: str,
) -> pd.DataFrame:
    """
    Download a Parquet object from MinIO and return it as a DataFrame.

    Parameters
    ----------
    client : Minio
        A connected Minio client.
    bucket : str
        Source bucket name.
    object_name : str
        Object key inside the bucket.

    Returns
    -------
    pd.DataFrame
        Parsed DataFrame.
    """
    log.info("Reading Parquet from MinIO: %s/%s", bucket, object_name)
    response = client.get_object(bucket, object_name)
    try:
        buf = io.BytesIO(response.read())
    finally:
        response.close()
        response.release_conn()

    df = pd.read_parquet(buf, engine="pyarrow")
    log.info("Loaded %d rows, %d columns", len(df), len(df.columns))
    return df
