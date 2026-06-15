#!/usr/bin/env python3
"""Build a Cloud Run env-vars YAML from a local .env file (minimal keys only)."""

from __future__ import annotations

import argparse
import base64
import os
import secrets
from pathlib import Path

# Keys pulled from the operator .env plus deploy-time defaults.
ENV_KEYS = [
    "COINMARKETCAP_API_KEY",
    "COINGLASS_API_KEY",
    "TAVILY_API_KEY",
    "NEWS_API_KEY",
    "DEEPSEEK_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_REGION",
    "SENTISCORE_S3_BUCKET",
    "SENTISCORE_S3_REGION",
    "GOOGLE_VERTEX_PROJECT",
    "GOOGLE_VERTEX_LOCATION",
    "LOCAL_DEV_MODE",
    "LOCAL_DEV_SUBSCRIPTION_TIER",
    "ZERO_EX_API_KEY",
    "MANTLE_RPC_URL",
    "MANTLE_CHAIN_ID",
    "MANTLE_PRIVATE_KEY",
    "MANTLE_AUDIT_LOG_ADDRESS",
    "MANTLE_MAX_TRADE_USD",
    "MANTLE_MAX_SLIPPAGE_BPS",
]

DEPLOY_DEFAULTS = {
    "PUBLIC_ACCESS_MODE": "1",
    # Multi-step CEX plan executor. Without this on the Cloud Run env,
    # runPlanModeIfApplicable short-circuits and multi-step / modified-strategy
    # requests fall back to the legacy single-action path (re-offers strategies
    # instead of executing the modified plan). Must be injected here because
    # .env is gitignored and is NOT the deployment source of truth.
    "CEX_PLAN_EXECUTION_ENABLED": "true",
    # StrategyEngineService — paper-only auto-execution loop. agent/src/index.ts
    # gates registration purely on this flag; start() no-ops without a
    # SQLite-backed adapter, which the Cloud Run deploy uses (DATABASE_ADAPTER=sqlite).
    # Injected here for the same reason as CEX_PLAN_EXECUTION_ENABLED: .env is
    # gitignored and is NOT the deployment source of truth.
    "STRATEGY_ENGINE_ENABLED": "true",
    "PAPER_TRADING_ENABLED": "true",
    "DATABASE_ADAPTER": "sqlite",
    "OTEL_TRACING_ENABLED": "true",
    "DEFAULT_LOG_LEVEL": "info",
}


def clean_env_value(value: str) -> str:
    value = value.strip()
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        value = value[1:-1]
    if "#" in value:
        value = value.split("#", 1)[0].strip()
    return value.strip().strip('"').strip("'")


def parse_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = clean_env_value(value)
        if value:
            out[key] = value
    return out


def yaml_escape(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-env", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--service-url", default="")
    args = parser.parse_args()

    source = parse_env(args.source_env)
    merged = dict(DEPLOY_DEFAULTS)
    # Cloud Run uses the deploy project's service account (ADC), not a cross-project key.
    merged["GOOGLE_VERTEX_PROJECT"] = args.project_id

    for key in ENV_KEYS:
        if key == "GOOGLE_VERTEX_PROJECT":
            continue
        if key in source:
            merged[key] = source[key]

    if "EXCHANGE_TOKEN_ENCRYPTION_KEY" not in merged:
        existing_output = args.output
        if existing_output.is_file():
            for line in existing_output.read_text(encoding="utf-8").splitlines():
                if line.startswith("EXCHANGE_TOKEN_ENCRYPTION_KEY:"):
                    merged["EXCHANGE_TOKEN_ENCRYPTION_KEY"] = line.split(":", 1)[1].strip().strip('"')
                    break
    if "EXCHANGE_TOKEN_ENCRYPTION_KEY" not in merged:
        merged["EXCHANGE_TOKEN_ENCRYPTION_KEY"] = base64.b64encode(
            secrets.token_bytes(32)
        ).decode("ascii")

    if "LOCAL_DEV_MODE" not in merged:
        merged["LOCAL_DEV_MODE"] = "1"
    if "LOCAL_DEV_SUBSCRIPTION_TIER" not in merged:
        merged["LOCAL_DEV_SUBSCRIPTION_TIER"] = "plus"
    if "GOOGLE_VERTEX_LOCATION" not in merged:
        merged["GOOGLE_VERTEX_LOCATION"] = "global"

    if args.service_url:
        merged["CORS_ORIGIN"] = args.service_url
        merged["ALLOWED_ORIGINS"] = args.service_url
    elif "CORS_ORIGIN" in source:
        merged["CORS_ORIGIN"] = source["CORS_ORIGIN"]
    if "ALLOWED_ORIGINS" in source and "ALLOWED_ORIGINS" not in merged:
        merged["ALLOWED_ORIGINS"] = source["ALLOWED_ORIGINS"]

    lines = [f"{key}: {yaml_escape(value)}" for key, value in sorted(merged.items())]
    args.output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {len(merged)} env vars to {args.output}")


if __name__ == "__main__":
    main()
