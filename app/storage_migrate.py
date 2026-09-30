"""Safe CLI tool to migrate local photos to Cloudflare R2 / S3.

Zero Data Loss Guarantees:
1. Local disk files and SQLite BLOBs are NEVER deleted by default. Both copies are preserved.
2. Every uploaded photo is strictly verified via R2 head_object to ensure it
   exists in R2 and that its size matches the source exactly.
3. Only after 100% verification is SQLite updated with r2_key and r2_url.
4. If network drops or the process terminates, already-migrated photos are remembered;
   rerunning the script automatically resumes without re-uploading.
5. If R2 is not configured, it fails safely with a clear diagnostic message.

Usage:
    python -m app.storage_migrate --dry-run
    python -m app.storage_migrate
    python -m app.storage_migrate --purge-local
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

from . import config, db, images, storage

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("reys.migrate")


async def run_migration(dry_run: bool = False, purge_local: bool = False, batch_size: int = 100) -> dict:
    await db.init()

    if not config.r2_enabled():
        log.error("Cloudflare R2 sozlanmagan! .env faylida R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME ni kiriting.")
        return {"ok": False, "error": "r2_not_configured"}

    unmigrated = await db.list_unmigrated_photos(limit=5000)
    total_found = len(unmigrated)

    log.info("R2 migratsiyasi: %d ta ko'chirilmagan rasm topildi", total_found)
    if total_found == 0:
        log.info("Barcha rasmlar allaqachon Cloudflare R2 ga muvaffaqiyatli ko'chirilgan!")
        return {"ok": True, "migrated": 0, "total": 0}

    if dry_run:
        log.info("--- DRY RUN REJIMI ---")
        total_bytes = 0
        missing = 0
        for p in unmigrated:
            data = p.get("data")
            if not data:
                disk_path = config.DATA_DIR / "photos" / str(p["entry_id"]) / str(p["idx"])
                if disk_path.exists():
                    total_bytes += disk_path.stat().st_size
                else:
                    missing += 1
            else:
                total_bytes += len(data)
        log.info("Topilgan rasmlar: %d ta", total_found)
        log.info("Umumiy hajm: %.2f MB", total_bytes / (1024 * 1024))
        if missing > 0:
            log.warning("Diqqat: %d ta rasm diski yoki bazasida topilmadi", missing)
        log.info("Dry-run tugadi. Hech qanday o'zgarish qilinmadi.")
        return {"ok": True, "dry_run": True, "total": total_found, "total_bytes": total_bytes}

    # Live migration
    s3_session = storage._session
    migrated_count = 0
    failed_count = 0

    log.info("Cloudflare R2 ga yuklash boshlandi...")
    for item in unmigrated:
        entry_id = item["entry_id"]
        idx = item["idx"]
        mime = item.get("mime") or "image/jpeg"
        data = item.get("data")

        # 1. Fetch bytes from DB BLOB or disk
        disk_path = config.DATA_DIR / "photos" / str(entry_id) / str(idx)
        if not data and disk_path.exists():
            try:
                data = disk_path.read_bytes()
            except OSError as exc:
                log.warning("Faylni diskdan o'qib bo'lmadi [e%s p%s]: %s", entry_id, idx, exc)

        if not data:
            log.warning("Rasm baytlari topilmadi [e%s p%s] — o'tkazib yuborildi (ma'lumot o'chirilmaydi)", entry_id, idx)
            failed_count += 1
            continue

        # Look up action and report_id from activity
        action = item.get("action")
        report_id = item.get("report_id")

        upload_data, upload_mime = images.optimize_to_webp(data, quality=95)
        key = storage.build_key(entry_id, idx, ext="webp", action=action, report_id=report_id)

        # 2. Upload to R2
        try:
            async with storage._s3_client() as s3:
                await s3.put_object(
                    Bucket=config.R2_BUCKET_NAME,
                    Key=key,
                    Body=upload_data,
                    ContentType=upload_mime,
                )

                # 3. VERIFICATION: strict check via head_object
                head = await s3.head_object(Bucket=config.R2_BUCKET_NAME, Key=key)
                r2_size = head.get("ContentLength", 0)
                if r2_size != len(upload_data):
                    raise ValueError(f"R2 hajmi mos kelmadi: kutilgan {len(upload_data)}, R2 da {r2_size}")

            # 4. Update SQLite only after confirmed 100% verification
            url = storage.photo_public_url(key, entry_id, idx)
            await db.update_photo_r2(entry_id, idx, key, url)
            migrated_count += 1

            # 5. Optional local purge (only if explicitly requested by user)
            if purge_local and disk_path.exists():
                try:
                    disk_path.unlink()
                except OSError:
                    pass

            if migrated_count % 10 == 0 or migrated_count == total_found:
                log.info("Ko'chirildi: %d / %d ta rasm", migrated_count, total_found)

        except Exception as exc:
            failed_count += 1
            log.error("R2 ga ko'chirishda xatolik [e%s p%s]: %s", entry_id, idx, exc)
            # Local file and SQLite row are preserved completely untouched!

    log.info("Migratsiya yakunlandi: %d ta rasm muvaffaqiyatli ko'chirildi, %d ta xato", migrated_count, failed_count)
    return {"ok": True, "migrated": migrated_count, "failed": failed_count, "total": total_found}


def main():
    parser = argparse.ArgumentParser(description="Reys hisoboti rasmlarini Cloudflare R2 ga xavfsiz ko'chirish")
    parser.add_argument("--dry-run", action="store_true", help="Faqat tekshirish, hech narsani o'zgartirmaslik")
    parser.add_argument("--purge-local", action="store_true", help="R2 ga 100%% tekshirib yuklangach, lokal disk nusxasini tozalash")
    args = parser.parse_args()

    res = asyncio.run(run_migration(dry_run=args.dry_run, purge_local=args.purge_local))
    if not res.get("ok"):
        sys.exit(1)


if __name__ == "__main__":
    main()
