# Deployment Notes

This app is ready for a simple single-instance deployment.

## Recommended platform

- Render
- Railway

## Important current constraints

- Run only **one instance**.
- Live meeting state is kept in memory in `app.py`.
- SQLite is used for persistence, so use a writable disk path.

## Environment variables

- `PORT`: server port provided by the platform
- `SECRET_KEY`: Flask session secret
- `CLASSWATCH_DB_PATH`: writable SQLite path
- `CLASSWATCH_YOLO_MODEL`: path to YOLO weights file
- `CLASSWATCH_AUTO_DOWNLOAD_YOLO`: set to `1` to auto-download if missing
- `CLASSWATCH_SECURE_COOKIE`: set to `1` on HTTPS deployments
- `CLASSWATCH_STUN_URLS`: comma-separated STUN URLs
- `CLASSWATCH_TURN_URLS`: comma-separated TURN URLs
- `CLASSWATCH_TURN_USERNAME`: TURN username
- `CLASSWATCH_TURN_CREDENTIAL`: TURN credential
- `FLASK_DEBUG`: keep unset or `0` in production

## Render

The repo includes `render.yaml`. After pushing the project:

1. Create a new Render Blueprint service from the repo.
2. Attach a persistent disk if you want the DB and YOLO weights to survive redeploys.
3. Keep the service instance count at `1`.

Suggested disk-backed paths:

- `CLASSWATCH_DB_PATH=/var/data/classwatch.db`
- `CLASSWATCH_YOLO_MODEL=/var/data/models/yolov8n.pt`

## Railway

Use the same environment variables and start command:

```bash
python app.py
```

## WebRTC note

The app defaults to Google STUN for development. For real internet deployment,
set TURN credentials as environment variables so teacher/student media works
reliably across restrictive networks.
