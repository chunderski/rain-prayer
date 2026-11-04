/** Connection settings for the test database. Override with TEST_* env vars. */
export const TEST_DB = process.env.TEST_DB_NAME ?? "sentinel_test";
export const PG_HOST = process.env.TEST_PG_HOST ?? "localhost";
export const PG_PORT = process.env.TEST_PG_PORT ?? "5432";
export const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD ?? "sentinel-owner-local";
export const APP_PASSWORD = process.env.TEST_APP_PASSWORD ?? "sentinel-app-local";
export const OWNER_URL = `postgres://sentinel_owner:${OWNER_PASSWORD}@${PG_HOST}:${PG_PORT}/${TEST_DB}`;
export const APP_URL = `postgres://sentinel_app:${APP_PASSWORD}@${PG_HOST}:${PG_PORT}/${TEST_DB}`;
