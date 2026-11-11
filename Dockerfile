FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

# Create non-root runtime user per GCAF security guidelines
RUN groupadd -r appgroup && useradd -r -g appgroup -d /app -s /sbin/nologin appuser

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r /app/requirements.txt

COPY backend /app/backend
COPY frontend /app/frontend

RUN mkdir -p /tmp/vehicle_id_videos && chown -R appuser:appgroup /app /tmp/vehicle_id_videos

USER appuser

EXPOSE 8080

# Listen on 0.0.0.0:$PORT as required by Cloud Run
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
