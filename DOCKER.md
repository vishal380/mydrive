# Run MyDrive with Docker

## First run

1. Make sure Docker Desktop is running.
2. Copy `.env.docker.example` to `.env` in the project root and replace the database password with a strong password.
3. Keep `backend/.env` in place. Docker uses it for values such as `SESSION_SECRET` and SMTP settings. The Compose configuration overrides its database host and credentials for the PostgreSQL container.
4. From the project root, run:

   ```powershell
   docker compose up --build
   ```

5. Open <http://localhost:3000>.

Stop the app with `Ctrl+C`. Start it again in the background with `docker compose up -d` and stop it with `docker compose down`.

## Persistent data

PostgreSQL data is kept in the `postgres_data` Docker volume. Uploaded files are kept in `./storage`, and audit logs are kept in `./backend/logs`. These remain when containers are rebuilt or removed with `docker compose down`.

To delete the database and all data stored in Docker's database volume, run `docker compose down -v`. This permanently removes that database volume.

## Configuration notes

- The app listens on port 3000. Change the left side of `3000:3000` in `docker-compose.yml` to use a different host port.
- A single uploaded file can be up to 5 GB. Ensure the Docker host has enough free disk space.
- For HTTPS deployment, configure a reverse proxy and set `COOKIE_SECURE=true`.
- `backend/.env` contains application secrets and must not be committed.
