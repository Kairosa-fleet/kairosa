"""Application configuration, loaded from environment / .env."""

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- Service ---
    SERVICE_NAME: str = "tracking-service"
    ENVIRONMENT: str = "development"
    DEBUG: bool = True
    API_V1_PREFIX: str = "/v1"

    # --- Database ---
    DATABASE_URL: str = (
        "postgresql+asyncpg://tracking:tracking_dev_pw@localhost:5432/tracking"
    )
    DB_POOL_SIZE: int = 10
    DB_MAX_OVERFLOW: int = 20
    DB_ECHO: bool = False

    # --- Redis ---
    REDIS_URL: str = "redis://localhost:6379/0"

    # --- Auth ---
    JWT_SECRET: str = Field(min_length=32)
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30
    DEVICE_TOKEN_EXPIRE_DAYS: int = 365
    ENROLLMENT_CODE_EXPIRE_HOURS: int = 24

    # --- CORS ---
    CORS_ORIGINS: str = "http://localhost:3000"

    # --- Ingest validation ---
    MAX_PING_AGE_SECONDS: int = 86_400
    MAX_PING_FUTURE_SKEW_SECONDS: int = 300
    MAX_ACCURACY_METERS: float = 100.0
    MAX_BATCH_SIZE: int = 100

    # --- Integrity scoring ---
    # Above this implied speed between two fixes, we treat it as a teleport.
    MAX_PLAUSIBLE_SPEED_MPS: float = 60.0  # ~216 km/h
    TRUST_SUSPICIOUS_THRESHOLD: int = 70
    TRUST_SPOOFED_THRESHOLD: int = 40

    # --- Rate limiting (per identity, sliding window in Redis) ---
    RATE_LIMIT_LOGIN_PER_MINUTE: int = 10
    RATE_LIMIT_INGEST_PER_MINUTE: int = 120
    RATE_LIMIT_PROVISION_PER_HOUR: int = 20

    # --- Geocoding / routing ---
    # Same key as the map tiles; see docs/MAPPING_STACK.md.
    MAPTILER_KEY: str = ""
    # OSRM's public demo server is fine for development but is explicitly
    # not for production use — self-host or move to a paid provider before
    # real traffic. See docs/MAPPING_STACK.md.
    OSRM_BASE_URL: str = "https://router.project-osrm.org"

    # --- Feature flags ---
    # All three are OFF for now by explicit decision. The code paths are built
    # and tested; enabling is a config change, not a rebuild.
    #
    # Customers do NOT need any of this to track a shipment — the tracking
    # link is public and needs no login. These flags only govern *automated
    # outbound messaging* and *driver login credentials*.
    NOTIFICATIONS_ENABLED: bool = False   # email/SMS/WhatsApp auto-send
    SMS_ENABLED: bool = False             # needs a paid Indian provider
    DRIVER_CREDENTIALS_ENABLED: bool = False  # driver app login accounts

    # --- Notifications ---
    PUBLIC_WEB_URL: str = "http://localhost:3000"
    MAIL_FROM: str = ""
    MAIL_FROM_NAME: str = "Kairosa"
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_STARTTLS: bool = True

    # --- Document storage ---
    # Scanned RCs, insurance and permits live outside the database: they are
    # read rarely, streamed whole, and would bloat every backup of a table that
    # is otherwise small and hot.
    #
    # When the S3_* settings below are configured, uploads go to object storage
    # (Cloudflare R2 or any S3-compatible service). This is required in
    # production: a platform's local disk is ephemeral, so without it every
    # redeploy wipes every uploaded document. With them unset, UPLOAD_DIR on
    # local disk is used — fine for development and tests.
    UPLOAD_DIR: str = "uploads"
    MAX_UPLOAD_MB: int = 10
    S3_ENDPOINT_URL: str = ""      # e.g. https://<accountid>.r2.cloudflarestorage.com
    S3_BUCKET: str = ""
    S3_ACCESS_KEY_ID: str = ""
    S3_SECRET_ACCESS_KEY: str = ""
    S3_REGION: str = "auto"        # R2's convention; real regions also accepted

    # --- Compliance ---
    DOC_EXPIRY_WARN_DAYS: int = 30
    TRACKING_LINK_TTL_DAYS: int = 30

    # How long a trip is assumed to occupy its vehicle and driver when no end
    # time was given. Used only to detect double booking, so it is deliberately
    # generous: a missed clash costs a stranded consignment, a false clash
    # costs one override.
    TRIP_DEFAULT_DURATION_HOURS: int = 12

    # --- Liveness ---
    DEVICE_OFFLINE_AFTER_SECONDS: int = 600

    @field_validator("JWT_SECRET")
    @classmethod
    def _reject_placeholder_secret(cls, v: str) -> str:
        if v.strip().upper() in {"CHANGE_ME", "SECRET", "CHANGEME"}:
            raise ValueError("JWT_SECRET must be set to a real generated value")
        return v

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT.lower() in {"production", "prod"}


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


settings = get_settings()
