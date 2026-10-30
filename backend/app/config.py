import os
from dataclasses import dataclass, field


def _env_list(name: str, default: str) -> list[str]:
    return [v.strip() for v in os.getenv(name, default).split(",") if v.strip()]


@dataclass(frozen=True)
class Settings:
    database_url: str = os.getenv("DATABASE_URL", "sqlite:///./hcare.db")
    jwt_secret: str = os.getenv("JWT_SECRET", "dev-only-secret-change-me-in-production-0000")
    # Long-lived because health workers may stay offline for days between syncs.
    jwt_ttl_hours: int = int(os.getenv("JWT_TTL_HOURS", "168"))
    seed_demo_users: bool = os.getenv("SEED_DEMO_USERS", "1") == "1"
    cors_origins: list[str] = field(default_factory=lambda: _env_list("CORS_ORIGINS", "*"))
    # Reject plaintext sync payloads (on in docker-compose; tests opt in explicitly).
    require_encrypted_payloads: bool = os.getenv("REQUIRE_ENCRYPTED_PAYLOADS", "0") == "1"
    max_ops_per_push: int = 100
    max_pull_limit: int = 1000


settings = Settings()
