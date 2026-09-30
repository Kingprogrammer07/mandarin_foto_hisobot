"""Image optimization and conversion to WebP.

Converts any incoming photo format (JPEG, PNG, HEIC, HEIF, WEBP) to high-fidelity
WebP (quality 90-98%) with automatic EXIF orientation normalization and scaling.
"""
from __future__ import annotations

import io
import logging
from PIL import Image, ImageOps
import pillow_heif

log = logging.getLogger("reys.images")

# Register HEIF/HEIC decoder for iPhone camera photos
try:
    pillow_heif.register_heif_opener()
except Exception as exc:
    log.warning("failed to register heif opener: %s", exc)


def is_webp(data: bytes) -> bool:
    """Check if binary data has a WebP RIFF header."""
    return bool(data and len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP")


def optimize_to_webp(
    data: bytes,
    quality: int = 95,
    max_dimension: int = 2560,
) -> tuple[bytes, str]:
    """Convert raw image bytes to WebP format.

    Returns:
        tuple[bytes, str]: (webp_bytes, "image/webp")
    """
    if not data:
        return data, "image/jpeg"

    try:
        img = Image.open(io.BytesIO(data))
        # 1. Correct rotation from camera EXIF tag (iPhone / Android)
        img = ImageOps.exif_transpose(img)

        # 2. Scale down if larger than max_dimension while preserving aspect ratio
        w, h = img.size
        if max(w, h) > max_dimension:
            scale = max_dimension / max(w, h)
            new_size = (max(1, int(w * scale)), max(1, int(h * scale)))
            img = img.resize(new_size, Image.Resampling.LANCZOS)

        # 3. Ensure appropriate color mode (RGB or RGBA)
        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            img = img.convert("RGBA")
        elif img.mode != "RGB":
            img = img.convert("RGB")

        # 4. Save to WebP
        buf = io.BytesIO()
        img.save(
            buf,
            format="WEBP",
            quality=max(80, min(quality, 98)),
            method=4,
        )
        webp_bytes = buf.getvalue()
        return webp_bytes, "image/webp"

    except Exception as exc:
        log.warning("Image conversion to WebP failed: %s; preserving original bytes", exc)
        return data, "image/jpeg"
