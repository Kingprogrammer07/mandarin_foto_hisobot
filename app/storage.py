"""Cloudflare R2 (S3-compatible) async storage with automatic local fallback.

When R2 credentials are configured in .env, photos are streamed to Cloudflare R2
and served via CDN/direct URLs. When unconfigured, it seamlessly falls back to
local disk storage (data/photos/<entry_id>/<idx>).
"""
from __future__ import annotations

import logging
from pathlib import Path

import aioboto3
from botocore.exceptions import ClientError

from . import config

log = logging.getLogger("reys.storage")

_session = aioboto3.Session()
_PHOTO_DIR = config.DATA_DIR / "photos"


def _s3_client():
    return _session.client(
        "s3",
        endpoint_url=config.R2_ENDPOINT_URL,
        aws_access_key_id=config.R2_ACCESS_KEY_ID,
        aws_secret_access_key=config.R2_SECRET_ACCESS_KEY,
        region_name="auto",
    )


def build_key(
    entry_id: int,
    idx: int,
    ext: str = "webp",
    action: str | None = None,
    report_id: int | None = None,
) -> str:
    """Build a clean, structured R2 object key.

    Hierarchy: {action}/report_{report_id}/{entry_id}/{idx}.{ext}
    Example:   top/report_44/5915/0.webp
    Fallback:  entries/{entry_id}/{idx}.{ext}
    """
    clean_action = str(action).strip().lower() if action else None
    if clean_action and report_id is not None:
        return f"{clean_action}/report_{report_id}/{entry_id}/{idx}.{ext}"
    if clean_action:
        return f"{clean_action}/{entry_id}/{idx}.{ext}"
    return f"entries/{entry_id}/{idx}.{ext}"


def photo_public_url(key: str, entry_id: int, idx: int) -> str:
    """Return public CDN url if R2_PUBLIC_DOMAIN is configured, else fallback endpoint."""
    if config.R2_PUBLIC_DOMAIN and key:
        clean_domain = config.R2_PUBLIC_DOMAIN.rstrip("/")
        clean_key = key.lstrip("/")
        return f"{clean_domain}/{clean_key}"
    return f"/api/entry/{entry_id}/photo/{idx}"


async def upload_photo(
    entry_id: int,
    idx: int,
    data: bytes,
    mime: str = "image/webp",
    action: str | None = None,
    report_id: int | None = None,
) -> tuple[str, str]:
    """Upload photo bytes.

    Returns (r2_key, public_or_endpoint_url).
    """
    ext = "webp" if "webp" in mime else ("png" if "png" in mime else "jpg")
    key = build_key(entry_id, idx, ext=ext, action=action, report_id=report_id)

    if config.r2_enabled():
        try:
            async with _s3_client() as s3:
                await s3.put_object(
                    Bucket=config.R2_BUCKET_NAME,
                    Key=key,
                    Body=data,
                    ContentType=mime or "image/webp",
                )
            url = photo_public_url(key, entry_id, idx)
            log.info("uploaded photo to R2: key=%s (size=%d bytes)", key, len(data))
            return key, url
        except Exception as exc:
            log.exception("failed to upload to R2, falling back to local disk: %s", exc)

    # Local fallback
    dest = _PHOTO_DIR / str(entry_id) / str(idx)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    url = f"/api/entry/{entry_id}/photo/{idx}"
    return key, url


async def get_photo_bytes(key: str, entry_id: int, idx: int) -> tuple[bytes, str] | None:
    """Retrieve photo bytes + mime from R2 or local disk."""
    # 1. Try R2 if enabled
    if config.r2_enabled() and key:
        try:
            async with _s3_client() as s3:
                resp = await s3.get_object(Bucket=config.R2_BUCKET_NAME, Key=key)
                mime = resp.get("ContentType", "image/jpeg")
                async with resp["Body"] as stream:
                    content = await stream.read()
                return content, mime
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "NoSuchKey":
                log.warning("error reading R2 key=%s: %s", key, exc)
        except Exception as exc:
            log.warning("unexpected error reading R2 key=%s: %s", key, exc)

    # 2. Local disk fallback
    p = _PHOTO_DIR / str(entry_id) / str(idx)
    if p.exists():
        try:
            return p.read_bytes(), "image/jpeg"
        except OSError:
            pass

    return None


async def delete_photos(keys: list[str], entry_id: int | None = None) -> None:
    """Delete photos from R2 and local disk."""
    if config.r2_enabled() and keys:
        try:
            objects = [{"Key": k} for k in keys if k]
            if objects:
                async with _s3_client() as s3:
                    await s3.delete_objects(
                        Bucket=config.R2_BUCKET_NAME,
                        Delete={"Objects": objects, "Quiet": True},
                    )
                log.info("deleted %d photos from R2", len(objects))
        except Exception as exc:
            log.warning("failed to delete photos from R2: %s", exc)

    # Local disk cleanup
    if entry_id is not None:
        d = _PHOTO_DIR / str(entry_id)
        if d.exists():
            for f in d.iterdir():
                try:
                    f.unlink()
                except OSError:
                    pass
            try:
                d.rmdir()
            except OSError:
                pass
