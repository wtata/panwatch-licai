# Overlay licai onto official PanWatch image.
# Build context: this overlay/ directory (prebuilt static/ from frontend/dist).
FROM sunxiao0721/panwatch:latest

COPY src/modules/licai /app/src/modules/licai
COPY src/bootstrap/application.py /app/src/bootstrap/application.py
COPY src/platform/persistence/models.py /app/src/platform/persistence/models.py
COPY src/platform/persistence/migrations.py /app/src/platform/persistence/migrations.py
COPY static /app/static
