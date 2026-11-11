"""Database and video storage persistence layer for Cymbal Auto Group Trade-In App."""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import pathlib
import uuid
from typing import Any, Dict, List, Optional, Tuple

from google.cloud import bigquery, storage
from google.cloud.exceptions import NotFound

from backend.agents.vehicle_inspector import format_uk_reg, normalize_reg
from backend.models import SalespersonCreate, SearchVehiclesRequest, VehicleRecord

logger = logging.getLogger(__name__)

def _detect_default_project() -> str:
    env_proj = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("GCP_PROJECT")
    if env_proj:
        return env_proj
    try:
        import google.auth
        _, adc_proj = google.auth.default()
        return adc_proj or ""
    except Exception:
        return ""


PROJECT_ID = _detect_default_project() or "local-project"
REGION = os.environ.get("GOOGLE_CLOUD_REGION") or "us-central1"
BQ_DATASET = os.environ.get("BQ_DATASET") or "vehicle_id_demo"
BQ_TABLE = os.environ.get("BQ_TABLE") or "trade_in_inventory"
BQ_USERS_TABLE = os.environ.get("BQ_USERS_TABLE") or "sales_staff"
GCS_BUCKET = os.environ.get("GCS_BUCKET") or f"{PROJECT_ID}-vehicle-videos"

LOCAL_VIDEO_DIR = pathlib.Path("/tmp/vehicle_id_videos")
LOCAL_VIDEO_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_SEARCH_COLUMNS = {
    "registration_number": "registration_number",
    "vin": "vin",
    "make": "make",
    "model": "model",
    "variant": "variant",
    "colour": "colour",
    "modifications": "modifications",
    "mot_status": "mot_status",
    "comments": "comments",
    "salesperson": "salesperson",
    "recorded_at": "CAST(recorded_at AS STRING)",
}


class VehicleStorageManager:
    """Manages trade-in vehicle records, salespeople, and walkaround video storage."""

    def __init__(self) -> None:
        self.project_id = PROJECT_ID
        self.dataset_id = BQ_DATASET
        self.table_id = BQ_TABLE
        self.users_table_id = BQ_USERS_TABLE
        self.bucket_name = GCS_BUCKET
        self.full_table_id = f"{self.project_id}.{self.dataset_id}.{self.table_id}"
        self.full_users_table_id = f"{self.project_id}.{self.dataset_id}.{self.users_table_id}"

        self._bq_client: Optional[bigquery.Client] = None
        self._gcs_client: Optional[storage.Client] = None
        self.bq_connected: bool = False
        self.gcs_connected: bool = False

        # In-memory mirrors (no sample data seeded)
        self._records: Dict[str, Dict[str, Any]] = {}
        self._salespeople: Dict[str, Dict[str, Any]] = {}

    def initialize_cloud_resources(self) -> Dict[str, Any]:
        """Connects to database & video storage using ADC and ensures schemas exist."""
        status = {
            "database_ready": False,
            "video_storage_ready": False,
        }

        try:
            client_proj = None if self.project_id == "local-project" else self.project_id
            self._bq_client = bigquery.Client(project=client_proj)
            if self._bq_client.project:
                self.project_id = self._bq_client.project
                self.full_table_id = f"{self.project_id}.{self.dataset_id}.{self.table_id}"
                self.full_users_table_id = f"{self.project_id}.{self.dataset_id}.{self.users_table_id}"
                if not os.environ.get("GCS_BUCKET"):
                    self.bucket_name = f"{self.project_id}-vehicle-videos"
            dataset_ref = bigquery.Dataset(f"{self.project_id}.{self.dataset_id}")
            dataset_ref.location = "US"
            try:
                self._bq_client.get_dataset(dataset_ref, timeout=15)
            except NotFound:
                self._bq_client.create_dataset(dataset_ref, exists_ok=True, timeout=15)

            vehicle_schema = [
                bigquery.SchemaField("registration_number", "STRING", mode="REQUIRED"),
                bigquery.SchemaField("vin", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("make", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("model", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("variant", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("year", "INTEGER", mode="NULLABLE"),
                bigquery.SchemaField("colour", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("condition_inside", "INTEGER", mode="NULLABLE"),
                bigquery.SchemaField("condition_inside_issues", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("condition_outside", "INTEGER", mode="NULLABLE"),
                bigquery.SchemaField("condition_outside_issues", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("modifications", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("mot_status", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("mileage", "INTEGER", mode="NULLABLE"),
                bigquery.SchemaField("purchase_value", "FLOAT", mode="NULLABLE"),
                bigquery.SchemaField("retail_value", "FLOAT", mode="NULLABLE"),
                bigquery.SchemaField("comments", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("salesperson", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("recorded_at", "TIMESTAMP", mode="NULLABLE"),
                bigquery.SchemaField("video_gcs_uri", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("video_url", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("sold", "BOOLEAN", mode="NULLABLE"),
                bigquery.SchemaField("field_sources_json", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("valuation_report_json", "STRING", mode="NULLABLE"),
            ]
            table_ref = bigquery.Table(self.full_table_id, schema=vehicle_schema)
            try:
                self._bq_client.get_table(table_ref, timeout=15)
            except NotFound:
                self._bq_client.create_table(table_ref, exists_ok=True, timeout=15)

            users_schema = [
                bigquery.SchemaField("id", "STRING", mode="REQUIRED"),
                bigquery.SchemaField("name", "STRING", mode="REQUIRED"),
                bigquery.SchemaField("branch", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("email", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("created_at", "TIMESTAMP", mode="NULLABLE"),
            ]
            users_table_ref = bigquery.Table(self.full_users_table_id, schema=users_schema)
            try:
                self._bq_client.get_table(users_table_ref, timeout=15)
            except NotFound:
                self._bq_client.create_table(users_table_ref, exists_ok=True, timeout=15)

            self.bq_connected = True
            status["database_ready"] = True
            self._load_existing_records()
            self._load_existing_salespeople()
        except Exception as exc:
            logger.warning("Database initialization notice: %s", exc)

        try:
            gcs_proj = None if self.project_id == "local-project" else self.project_id
            self._gcs_client = storage.Client(project=gcs_proj)
            if self._gcs_client.project and self.project_id == "local-project":
                self.project_id = self._gcs_client.project
                if not os.environ.get("GCS_BUCKET"):
                    self.bucket_name = f"{self.project_id}-vehicle-videos"
            bucket = self._gcs_client.bucket(self.bucket_name)
            if not bucket.exists(timeout=15):
                bucket.storage_class = "STANDARD"
                bucket.iam_configuration.uniform_bucket_level_access_enabled = True
                bucket.add_lifecycle_delete_rule(age=7)
                self._gcs_client.create_bucket(bucket, location=REGION, timeout=15)
            self.gcs_connected = True
            status["video_storage_ready"] = True
        except Exception as exc:
            logger.warning("Video storage initialization notice: %s", exc)

        return status

    def _load_existing_records(self) -> None:
        """Loads any existing real vehicle records from the database (without seeding sample data)."""
        if not self._bq_client:
            return
        try:
            query = f"SELECT * FROM `{self.full_table_id}` ORDER BY recorded_at DESC LIMIT 200"
            rows = list(self._bq_client.query(query, timeout=20).result(timeout=20))
            for row in rows:
                record = self._row_to_dict(row)
                self._records[normalize_reg(record["registration_number"])] = record
        except Exception as exc:
            logger.warning("Load vehicles notice: %s", exc)

    def _load_existing_salespeople(self) -> None:
        """Loads existing salespeople from the database."""
        if not self._bq_client:
            return
        try:
            query = f"SELECT id, name, branch, email, created_at FROM `{self.full_users_table_id}` ORDER BY name ASC LIMIT 200"
            rows = list(self._bq_client.query(query, timeout=20).result(timeout=20))
            for row in rows:
                d = dict(row.items())
                created_at = d.get("created_at")
                if isinstance(created_at, dt.datetime):
                    d["created_at"] = created_at.strftime("%Y-%m-%dT%H:%M:%SZ")
                else:
                    d["created_at"] = str(created_at or "")
                d["display_label"] = self._format_salesperson_label(d["name"], d.get("branch", ""), d.get("email", ""))
                self._salespeople[d["id"]] = d
        except Exception as exc:
            logger.warning("Load salespeople notice: %s", exc)

    @staticmethod
    def _format_salesperson_label(name: str, branch: str, email: str) -> str:
        parts = [name.strip()]
        if branch and branch.strip():
            parts.append(f"— {branch.strip()}")
        if email and email.strip():
            parts.append(f"({email.strip()})")
        return " ".join(parts)

    def list_salespeople(self) -> List[Dict[str, Any]]:
        """Returns all salespeople ordered by name."""
        if self.bq_connected and self._bq_client:
            self._load_existing_salespeople()
        items = list(self._salespeople.values())
        items.sort(key=lambda x: x.get("name", "").lower())
        return items

    def add_salesperson(self, req: SalespersonCreate) -> Dict[str, Any]:
        """Adds a new salesperson user to the database."""
        user_id = f"sp_{uuid.uuid4().hex[:10]}"
        now_iso = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        name = req.name.strip()
        branch = (req.branch or "").strip()
        email = (req.email or "").strip()
        display_label = self._format_salesperson_label(name, branch, email)

        user_doc = {
            "id": user_id,
            "name": name,
            "branch": branch,
            "email": email,
            "created_at": now_iso,
            "display_label": display_label,
        }
        self._salespeople[user_id] = user_doc

        if self.bq_connected and self._bq_client:
            try:
                insert_sql = f"""
                INSERT INTO `{self.full_users_table_id}` (id, name, branch, email, created_at)
                VALUES (@id, @name, @branch, @email, TIMESTAMP(@created_at))
                """
                job_config = bigquery.QueryJobConfig(
                    query_parameters=[
                        bigquery.ScalarQueryParameter("id", "STRING", user_id),
                        bigquery.ScalarQueryParameter("name", "STRING", name),
                        bigquery.ScalarQueryParameter("branch", "STRING", branch),
                        bigquery.ScalarQueryParameter("email", "STRING", email),
                        bigquery.ScalarQueryParameter("created_at", "STRING", now_iso),
                    ]
                )
                self._bq_client.query(insert_sql, job_config=job_config, timeout=20).result(timeout=20)
            except Exception as exc:
                logger.warning("Salesperson insert notice: %s", exc)

        return user_doc

    def _row_to_dict(self, row: Any) -> Dict[str, Any]:
        """Converts a database Row into our standard dictionary representation."""
        d = dict(row.items())
        rec_at = d.get("recorded_at")
        if isinstance(rec_at, dt.datetime):
            d["recorded_at"] = rec_at.strftime("%Y-%m-%dT%H:%M:%SZ")
        elif rec_at is not None:
            d["recorded_at"] = str(rec_at)

        try:
            d["field_sources"] = json.loads(d.pop("field_sources_json", "{}") or "{}")
        except Exception:
            d["field_sources"] = {}
        try:
            d["valuation_report"] = json.loads(d.pop("valuation_report_json", "null") or "null")
        except Exception:
            d["valuation_report"] = None
        d["sold"] = bool(d.get("sold", False))
        return d

    def upload_video(
        self,
        registration_number: str,
        video_bytes: bytes,
        mime_type: str,
        salesperson: str,
    ) -> Tuple[str, str]:
        """Saves video linked to the vehicle registration in storage and local playback cache."""
        norm_reg = normalize_reg(registration_number) or "VEHICLE"
        timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        ext = "mp4" if "mp4" in (mime_type or "").lower() else "webm"
        filename = f"{norm_reg}_{timestamp}.{ext}"

        local_path = LOCAL_VIDEO_DIR / filename
        local_path.write_bytes(video_bytes)
        local_url = f"/api/videos/file/{filename}"
        gcs_uri = f"gs://{self.bucket_name}/videos/{norm_reg}/{filename}"

        if self.gcs_connected and self._gcs_client:
            try:
                bucket = self._gcs_client.bucket(self.bucket_name)
                blob = bucket.blob(f"videos/{norm_reg}/{filename}")
                blob.metadata = {
                    "registration_number": format_uk_reg(registration_number),
                    "salesperson": salesperson,
                    "recorded_at": timestamp,
                }
                blob.upload_from_string(video_bytes, content_type=mime_type or "video/webm", timeout=30)
            except Exception as exc:
                logger.warning("Video storage upload fallback: %s", exc)

        return gcs_uri, local_url

    def save_vehicle(self, record: VehicleRecord) -> Dict[str, Any]:
        """Saves or updates a trade-in vehicle record using registration_number as unique key."""
        formatted_reg = format_uk_reg(record.registration_number)
        norm_reg = normalize_reg(formatted_reg)
        now_iso = record.recorded_at or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        data = record.model_dump()
        data["registration_number"] = formatted_reg
        data["recorded_at"] = now_iso
        if not data.get("video_gcs_uri"):
            data["video_gcs_uri"] = f"gs://{self.bucket_name}/videos/{norm_reg}/walkaround_{norm_reg.lower()}.webm"

        self._records[norm_reg] = data

        if self.bq_connected and self._bq_client:
            self._upsert_bigquery_row(data)

        return data

    def _upsert_bigquery_row(self, data: Dict[str, Any]) -> None:
        """Executes a parameterized MERGE statement keyed by registration_number."""
        if not self._bq_client:
            return
        try:
            merge_sql = f"""
            MERGE `{self.full_table_id}` T
            USING (
                SELECT
                    @registration_number AS registration_number,
                    @vin AS vin,
                    @make AS make,
                    @model AS model,
                    @variant AS variant,
                    @year AS year,
                    @colour AS colour,
                    @condition_inside AS condition_inside,
                    @condition_inside_issues AS condition_inside_issues,
                    @condition_outside AS condition_outside,
                    @condition_outside_issues AS condition_outside_issues,
                    @modifications AS modifications,
                    @mot_status AS mot_status,
                    @mileage AS mileage,
                    @purchase_value AS purchase_value,
                    @retail_value AS retail_value,
                    @comments AS comments,
                    @salesperson AS salesperson,
                    TIMESTAMP(@recorded_at) AS recorded_at,
                    @video_gcs_uri AS video_gcs_uri,
                    @video_url AS video_url,
                    @sold AS sold,
                    @field_sources_json AS field_sources_json,
                    @valuation_report_json AS valuation_report_json
            ) S
            ON UPPER(REPLACE(T.registration_number, ' ', '')) = UPPER(REPLACE(S.registration_number, ' ', ''))
            WHEN MATCHED THEN
                UPDATE SET
                    registration_number = S.registration_number,
                    vin = S.vin,
                    make = S.make,
                    model = S.model,
                    variant = S.variant,
                    year = S.year,
                    colour = S.colour,
                    condition_inside = S.condition_inside,
                    condition_inside_issues = S.condition_inside_issues,
                    condition_outside = S.condition_outside,
                    condition_outside_issues = S.condition_outside_issues,
                    modifications = S.modifications,
                    mot_status = S.mot_status,
                    mileage = S.mileage,
                    purchase_value = S.purchase_value,
                    retail_value = S.retail_value,
                    comments = S.comments,
                    salesperson = S.salesperson,
                    recorded_at = S.recorded_at,
                    video_gcs_uri = S.video_gcs_uri,
                    video_url = S.video_url,
                    sold = S.sold,
                    field_sources_json = S.field_sources_json,
                    valuation_report_json = S.valuation_report_json
            WHEN NOT MATCHED THEN
                INSERT (
                    registration_number, vin, make, model, variant, year, colour,
                    condition_inside, condition_inside_issues, condition_outside, condition_outside_issues,
                    modifications, mot_status, mileage, purchase_value, retail_value,
                    comments, salesperson, recorded_at, video_gcs_uri, video_url, sold,
                    field_sources_json, valuation_report_json
                )
                VALUES (
                    S.registration_number, S.vin, S.make, S.model, S.variant, S.year, S.colour,
                    S.condition_inside, S.condition_inside_issues, S.condition_outside, S.condition_outside_issues,
                    S.modifications, S.mot_status, S.mileage, S.purchase_value, S.retail_value,
                    S.comments, S.salesperson, S.recorded_at, S.video_gcs_uri, S.video_url, S.sold,
                    S.field_sources_json, S.valuation_report_json
                )
            """
            job_config = bigquery.QueryJobConfig(
                query_parameters=[
                    bigquery.ScalarQueryParameter("registration_number", "STRING", data["registration_number"]),
                    bigquery.ScalarQueryParameter("vin", "STRING", data.get("vin", "")),
                    bigquery.ScalarQueryParameter("make", "STRING", data.get("make", "")),
                    bigquery.ScalarQueryParameter("model", "STRING", data.get("model", "")),
                    bigquery.ScalarQueryParameter("variant", "STRING", data.get("variant", "")),
                    bigquery.ScalarQueryParameter("year", "INT64", int(data.get("year") or 2021)),
                    bigquery.ScalarQueryParameter("colour", "STRING", data.get("colour", "")),
                    bigquery.ScalarQueryParameter("condition_inside", "INT64", int(data.get("condition_inside") or 8)),
                    bigquery.ScalarQueryParameter("condition_inside_issues", "STRING", data.get("condition_inside_issues", "")),
                    bigquery.ScalarQueryParameter("condition_outside", "INT64", int(data.get("condition_outside") or 8)),
                    bigquery.ScalarQueryParameter("condition_outside_issues", "STRING", data.get("condition_outside_issues", "")),
                    bigquery.ScalarQueryParameter("modifications", "STRING", data.get("modifications", "")),
                    bigquery.ScalarQueryParameter("mot_status", "STRING", data.get("mot_status", "")),
                    bigquery.ScalarQueryParameter("mileage", "INT64", int(data.get("mileage") or 0)),
                    bigquery.ScalarQueryParameter("purchase_value", "FLOAT64", float(data.get("purchase_value") or 0.0)),
                    bigquery.ScalarQueryParameter("retail_value", "FLOAT64", float(data.get("retail_value") or 0.0)),
                    bigquery.ScalarQueryParameter("comments", "STRING", data.get("comments", "")),
                    bigquery.ScalarQueryParameter("salesperson", "STRING", data.get("salesperson", "")),
                    bigquery.ScalarQueryParameter("recorded_at", "STRING", data.get("recorded_at")),
                    bigquery.ScalarQueryParameter("video_gcs_uri", "STRING", data.get("video_gcs_uri", "")),
                    bigquery.ScalarQueryParameter("video_url", "STRING", data.get("video_url", "")),
                    bigquery.ScalarQueryParameter("sold", "BOOL", bool(data.get("sold", False))),
                    bigquery.ScalarQueryParameter("field_sources_json", "STRING", json.dumps(data.get("field_sources") or {})),
                    bigquery.ScalarQueryParameter("valuation_report_json", "STRING", json.dumps(data.get("valuation_report"))),
                ]
            )
            self._bq_client.query(merge_sql, job_config=job_config, timeout=25).result(timeout=25)
        except Exception as exc:
            logger.warning("Database MERGE warning (cached locally): %s", exc)

    def mark_vehicle_sold(self, registration_number: str, sold: bool = True) -> Optional[Dict[str, Any]]:
        """Updates the `sold` status of a vehicle and returns the updated record."""
        norm_reg = normalize_reg(registration_number)
        record = self._records.get(norm_reg)
        if record:
            record["sold"] = bool(sold)

        if self.bq_connected and self._bq_client:
            try:
                update_sql = f"""
                UPDATE `{self.full_table_id}`
                SET sold = @sold
                WHERE UPPER(REPLACE(registration_number, ' ', '')) = @norm_reg
                """
                job_config = bigquery.QueryJobConfig(
                    query_parameters=[
                        bigquery.ScalarQueryParameter("sold", "BOOL", bool(sold)),
                        bigquery.ScalarQueryParameter("norm_reg", "STRING", norm_reg),
                    ]
                )
                self._bq_client.query(update_sql, job_config=job_config, timeout=20).result(timeout=20)
            except Exception as exc:
                logger.warning("Database UPDATE sold note: %s", exc)

        return record

    def search_vehicles(self, req: SearchVehiclesRequest) -> Dict[str, Any]:
        """Builds and executes a parameterized SQL query across user-selected fields and range filters."""
        selected_cols = [
            col for col in (req.search_fields or []) if col in ALLOWED_SEARCH_COLUMNS
        ]
        if not selected_cols:
            selected_cols = ["registration_number", "make", "model", "colour", "comments", "salesperson"]

        where_clauses = ["1=1"]
        params: List[bigquery.ScalarQueryParameter] = []

        q_text = (req.query_text or "").strip()
        if q_text:
            or_parts = []
            for col in selected_cols:
                sql_expr = ALLOWED_SEARCH_COLUMNS[col]
                or_parts.append(f"LOWER(IFNULL({sql_expr}, '')) LIKE @query_like")
            where_clauses.append("(" + " OR ".join(or_parts) + ")")
            params.append(bigquery.ScalarQueryParameter("query_like", "STRING", f"%{q_text.lower()}%"))

        if req.make_filter and req.make_filter.lower() != "all":
            where_clauses.append("LOWER(make) = @make_filter")
            params.append(bigquery.ScalarQueryParameter("make_filter", "STRING", req.make_filter.lower()))

        if req.colour_filter and req.colour_filter.lower() != "all":
            where_clauses.append("LOWER(colour) LIKE @colour_filter")
            params.append(bigquery.ScalarQueryParameter("colour_filter", "STRING", f"%{req.colour_filter.lower()}%"))

        if req.date_from:
            where_clauses.append("DATE(recorded_at) >= @date_from")
            params.append(bigquery.ScalarQueryParameter("date_from", "STRING", req.date_from))

        if req.date_to:
            where_clauses.append("DATE(recorded_at) <= @date_to")
            params.append(bigquery.ScalarQueryParameter("date_to", "STRING", req.date_to))

        if req.min_price is not None:
            where_clauses.append("purchase_value >= @min_price")
            params.append(bigquery.ScalarQueryParameter("min_price", "FLOAT64", float(req.min_price)))

        if req.max_price is not None:
            where_clauses.append("purchase_value <= @max_price")
            params.append(bigquery.ScalarQueryParameter("max_price", "FLOAT64", float(req.max_price)))

        if req.min_mileage is not None:
            where_clauses.append("mileage >= @min_mileage")
            params.append(bigquery.ScalarQueryParameter("min_mileage", "INT64", int(req.min_mileage)))

        if req.max_mileage is not None:
            where_clauses.append("mileage <= @max_mileage")
            params.append(bigquery.ScalarQueryParameter("max_mileage", "INT64", int(req.max_mileage)))

        if req.sold_filter == "available":
            where_clauses.append("IFNULL(sold, FALSE) = FALSE")
        elif req.sold_filter == "sold":
            where_clauses.append("IFNULL(sold, FALSE) = TRUE")

        order_map = {
            "recorded_at_desc": "recorded_at DESC",
            "price_asc": "purchase_value ASC",
            "price_desc": "purchase_value DESC",
            "mileage_asc": "mileage ASC",
            "mileage_desc": "mileage DESC",
        }
        order_sql = order_map.get(req.sort_by, "recorded_at DESC")
        limit_val = max(1, min(int(req.limit or 50), 200))

        sql_query = (
            f"SELECT registration_number, vin, make, model, variant, year, colour, "
            f"condition_inside, condition_inside_issues, condition_outside, condition_outside_issues, "
            f"modifications, mot_status, mileage, purchase_value, retail_value, comments, "
            f"salesperson, recorded_at, video_gcs_uri, video_url, sold, "
            f"field_sources_json, valuation_report_json\n"
            f"FROM `{self.full_table_id}`\n"
            f"WHERE {' AND '.join(where_clauses)}\n"
            f"ORDER BY {order_sql}\n"
            f"LIMIT {limit_val}"
        )

        results: Optional[List[Dict[str, Any]]] = None

        if self.bq_connected and self._bq_client:
            try:
                job_config = bigquery.QueryJobConfig(query_parameters=params)
                rows = list(self._bq_client.query(sql_query, job_config=job_config, timeout=20).result(timeout=20))
                results = [self._row_to_dict(r) for r in rows]
                for item in results:
                    norm = normalize_reg(item["registration_number"])
                    if norm in self._records:
                        item["sold"] = self._records[norm]["sold"]
            except Exception as exc:
                logger.warning("Database search fallback to in-memory filter: %s", exc)

        if results is None:
            results = self._filter_in_memory(req, selected_cols)

        return {
            "vehicles": results,
            "count": len(results),
            "searched_fields": selected_cols,
        }

    def _filter_in_memory(
        self, req: SearchVehiclesRequest, selected_cols: List[str]
    ) -> List[Dict[str, Any]]:
        """Executes identical search & range filtering over the in-memory mirror."""
        items = list(self._records.values())
        q = (req.query_text or "").strip().lower()

        filtered = []
        for item in items:
            if q:
                matched = False
                for col in selected_cols:
                    val = str(item.get(col, "") or "").lower()
                    if q in val:
                        matched = True
                        break
                if not matched:
                    continue

            if req.make_filter and req.make_filter.lower() != "all":
                if str(item.get("make", "")).lower() != req.make_filter.lower():
                    continue
            if req.colour_filter and req.colour_filter.lower() != "all":
                if req.colour_filter.lower() not in str(item.get("colour", "")).lower():
                    continue
            if req.date_from:
                rec_date = str(item.get("recorded_at", ""))[:10]
                if rec_date and rec_date < req.date_from:
                    continue
            if req.date_to:
                rec_date = str(item.get("recorded_at", ""))[:10]
                if rec_date and rec_date > req.date_to:
                    continue
            if req.min_price is not None and float(item.get("purchase_value") or 0) < req.min_price:
                continue
            if req.max_price is not None and float(item.get("purchase_value") or 0) > req.max_price:
                continue
            if req.min_mileage is not None and int(item.get("mileage") or 0) < req.min_mileage:
                continue
            if req.max_mileage is not None and int(item.get("mileage") or 0) > req.max_mileage:
                continue
            if req.sold_filter == "available" and item.get("sold"):
                continue
            if req.sold_filter == "sold" and not item.get("sold"):
                continue

            filtered.append(item)

        if req.sort_by == "price_asc":
            filtered.sort(key=lambda x: float(x.get("purchase_value") or 0))
        elif req.sort_by == "price_desc":
            filtered.sort(key=lambda x: float(x.get("purchase_value") or 0), reverse=True)
        elif req.sort_by == "mileage_asc":
            filtered.sort(key=lambda x: int(x.get("mileage") or 0))
        elif req.sort_by == "mileage_desc":
            filtered.sort(key=lambda x: int(x.get("mileage") or 0), reverse=True)
        else:
            filtered.sort(key=lambda x: str(x.get("recorded_at") or ""), reverse=True)

        return filtered[: int(req.limit or 50)]
