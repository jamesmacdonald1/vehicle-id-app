#!/usr/bin/env bash
# Cymbal Auto Group — Vehicle ID Cloud Run Deployment Script
# Usage: ./scripts/deploy.sh [PROJECT_ID] [REGION]

set -euo pipefail

PROJECT_ID="${1:-${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}}"
if [[ -z "${PROJECT_ID}" ]]; then
  echo "Usage: $0 <PROJECT_ID> [REGION] (or set GOOGLE_CLOUD_PROJECT / gcloud config project)" >&2
  exit 1
fi
REGION="${2:-${GOOGLE_CLOUD_REGION:-us-central1}}"
SERVICE_NAME="cymbal-vehicle-id"
SA_NAME="vehicle-id-sa"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
BUCKET_NAME="${PROJECT_ID}-vehicle-videos"
BQ_DATASET="vehicle_id_demo"
BQ_TABLE="trade_in_inventory"
BQ_USERS_TABLE="sales_staff"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.8-flash}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "==> Running prerequisite setup for project ${PROJECT_ID} (${REGION})..."
"${SCRIPT_DIR}/setup.sh" "${PROJECT_ID}" "${REGION}"

echo "==> Deploying ${SERVICE_NAME} to Cloud Run (min-instances=0 for scale-to-zero cost hygiene)..."
gcloud run deploy "${SERVICE_NAME}" \
  --source="${REPO_ROOT}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --service-account="${SA_EMAIL}" \
  --min-instances=0 \
  --max-instances=5 \
  --memory=2Gi \
  --cpu=2 \
  --timeout=300s \
  --allow-unauthenticated \
  --no-invoker-iam-check \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_REGION=${REGION},GEMINI_LOCATION=us,GCS_BUCKET=${BUCKET_NAME},BQ_DATASET=${BQ_DATASET},BQ_TABLE=${BQ_TABLE},BQ_USERS_TABLE=${BQ_USERS_TABLE},GEMINI_MODEL=${GEMINI_MODEL}" \
  --quiet

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" --region="${REGION}" --project="${PROJECT_ID}" --format="value(status.url)" --quiet)"
echo ""
echo "========================================================================"
echo "✅ Deployed Cymbal Auto Group Vehicle ID App to Cloud Run!"
echo "🌐 Service URL: ${SERVICE_URL}"
echo "🩺 Health Check: ${SERVICE_URL}/status"
echo "========================================================================"
