import time
import pytest
from app import config, db, storage_migrate

@pytest.mark.asyncio
async def test_migration_safety_checks():
    await db.init()
    # 1. When R2 is not enabled, migration fails safely without modifying any files
    orig_key = config.R2_ACCESS_KEY_ID
    try:
        config.R2_ACCESS_KEY_ID = ""
        res = await storage_migrate.run_migration(dry_run=True)
        assert res["ok"] is False
        assert res["error"] == "r2_not_configured"
    finally:
        config.R2_ACCESS_KEY_ID = orig_key

@pytest.mark.asyncio
async def test_unmigrated_photos_and_update():
    await db.init()
    rep = await db.create_report(f"Migrate Test {int(time.time() * 1000)}")
    rid = rep["id"]
    try:
        types_res = await db.list_types()
        t1 = types_res["types"][0]

        # Add a reys entry with photo and no r2_key
        add_res = await db.add_reys(rid, "tester", t1, 50.0, 0, 50.0, 1, 0)
        entry_id = add_res["entry_id"]
        fake_data = b"photo-bytes-for-migration-testing"
        await db.save_photos(entry_id, [(fake_data, "image/jpeg")], None)

        # Verify it shows up in unmigrated photos
        unmigrated = await db.list_unmigrated_photos()
        target = next((p for p in unmigrated if p["entry_id"] == entry_id and p["idx"] == 0), None)
        assert target is not None, "Photo should be listed as unmigrated"
        assert target["data"] == fake_data

        # Update photo with R2 metadata
        await db.update_photo_r2(entry_id, 0, "entries/test/0.jpg", "https://cdn.example.com/0.jpg")

        # Verify it is no longer in unmigrated list
        unmigrated_after = await db.list_unmigrated_photos()
        assert not any(p["entry_id"] == entry_id and p["idx"] == 0 for p in unmigrated_after)

        # Verify photo_data returns the new r2 metadata AND the original bytes
        p_data = await db.photo_data(entry_id, 0)
        assert p_data is not None
        assert p_data[0] == fake_data  # ORIGINAL BYTES PRESERVED!
        assert p_data[2] == "entries/test/0.jpg"
        assert p_data[3] == "https://cdn.example.com/0.jpg"

    finally:
        await db.delete_report(rid)
