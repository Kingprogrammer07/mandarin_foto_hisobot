import time
import pytest
from app import config, db, excel_export, queue, storage

@pytest.mark.asyncio
async def test_storage_fallback():
    fake_photo = b"fake-jpg-content-12345"
    key, url = await storage.upload_photo(999999, 0, fake_photo, "image/jpeg")
    assert key is not None
    assert url is not None
    data, mime = await storage.get_photo_bytes(key, 999999, 0)
    assert data == fake_photo
    assert mime == "image/jpeg"

@pytest.mark.asyncio
async def test_db_lifecycle_and_balances():
    await db.init()
    # Create unique report
    rep = await db.create_report(f"Test Report {int(time.time() * 1000)}")
    rid = rep["id"]
    try:
        # Verify default types exist
        types_res = await db.list_types()
        types = types_res["types"]
        assert len(types) >= 2
        t1, t2 = types[0], types[1]

        # Add reys
        add_res = await db.add_reys(rid, "tester", t1, 100.0, 5.0, 95.0, 1, 5.0)
        entry_id = add_res["entry_id"]
        assert abs(add_res["balance"] - 95.0) < 1e-4

        # Save photo metadata
        await db.save_photos(entry_id, [(b"dummy", "image/jpeg")], [("key1", "http://r2/url1")])
        p_data = await db.photo_data(entry_id, 0)
        assert p_data is not None
        assert p_data[2] == "key1"
        assert p_data[3] == "http://r2/url1"

        # Edit reys
        edit_res = await db.edit_reys(rid, entry_id, t1, 110.0, 5.0, 105.0, 5.0)
        assert abs(edit_res["balance"] - 105.0) < 1e-4

        # Adjust (transfer 25kg from t1 to t2)
        adj_res = await db.adjust(rid, "tester", t1, t2, 25.0, 0)
        assert abs(adj_res["balances"][t1] - 80.0) < 1e-4
        assert abs(adj_res["balances"][t2] - 25.0) < 1e-4

        # Test InsufficientStock exception
        with pytest.raises(db.InsufficientStock):
            await db.adjust(rid, "tester", t1, t2, 99999.0, 0)

        # Obshiy ves
        ob_res = await db.add_obshiy(rid, "tester", "top", "BOX-99", 50.0, 0, 50.0, 0, 2.0)
        assert ob_res["entry_id"] is not None

        # Batch entries list
        entries = await db.list_entries(rid, "reys")
        assert len(entries) >= 1
        assert "photo_urls" in entries[0]

        # Excel export verification
        k_bytes, _ = await excel_export.build_kargo_excel(rid)
        assert len(k_bytes) > 0
        o_bytes, _ = await excel_export.build_obshiy_excel(rid)
        assert len(o_bytes) > 0
        u_bytes, _ = await excel_export.build_umumiy_excel(rid)
        assert len(u_bytes) > 0

        # Queue dispatch
        await db.enqueue_bulk_send(rid, "reys", mode="all")
        await queue.dispatch_send()

    finally:
        await db.delete_report(rid)


@pytest.mark.asyncio
async def test_report_rename_and_max_limit():
    await db.init()
    assert config.MAX_REPORTS >= 200
    assert db.MAX_REPORTS == config.MAX_REPORTS

    ts = int(time.time() * 1000)
    rep1 = await db.create_report(f"Rename Test 1 {ts}")
    rep2 = await db.create_report(f"Rename Test 2 {ts}")
    rid1 = rep1["id"]
    rid2 = rep2["id"]

    try:
        # Successful rename
        renamed = await db.rename_report(rid1, f"Renamed 1 {ts}")
        assert renamed["name"] == f"Renamed 1 {ts}"

        # Same name is a no-op
        same = await db.rename_report(rid1, f"Renamed 1 {ts}")
        assert same["name"] == f"Renamed 1 {ts}"

        # Duplicate name raises DuplicateName
        with pytest.raises(db.DuplicateName):
            await db.rename_report(rid1, f"Rename Test 2 {ts}")

        # Empty name raises ValueError
        with pytest.raises(ValueError):
            await db.rename_report(rid1, "   ")

        # Name too long raises ValueError
        with pytest.raises(ValueError):
            await db.rename_report(rid1, "A" * 65)

        # Non-existent report raises ReportNotFound
        with pytest.raises(db.ReportNotFound):
            await db.rename_report(9999999, "Non existent")
    finally:
        await db.delete_report(rid1)
        await db.delete_report(rid2)


def test_normalize_type_key_distinct():
    # In general (reports, Excel), x-codes are normalized to xabib as before
    assert db.normalize_type_key("x637") == "xabib"
    assert db.normalize_type_key("x517") == "xabib"
    assert db.normalize_type_key("x657") == "xabib"
    assert db.normalize_type_key("xabib") == "xabib"
    assert db.normalize_type_key("one") == "oneway"
    assert db.normalize_type_key("uztez") == "uzt"

    # For Telegram sending ONLY, x-codes are strictly distinct and not conflated with xabib
    assert db.normalize_telegram_type_key("x637") == "x637"
    assert db.normalize_telegram_type_key("x517") == "x517"
    assert db.normalize_telegram_type_key("x657") == "x657"
    assert db.normalize_telegram_type_key("xabib") == "xabib"
    assert db.normalize_telegram_type_key("x637") != db.normalize_telegram_type_key("xabib")
    assert db.normalize_telegram_type_key("x517") != db.normalize_telegram_type_key("xabib")
    assert db.normalize_telegram_type_key("x657") != db.normalize_telegram_type_key("xabib")


@pytest.mark.asyncio
async def test_uppercase_tovar_turi():
    await db.init()
    for t in db.DEFAULT_TYPES:
        assert t == t.upper()

    rep = await db.create_report(f"Uppercase Test {int(time.time() * 1000)}")
    rid = rep["id"]
    try:
        res = await db.add_reys(rid, "tester", "akb", 25.0, 1.0, 24.0, 0)
        assert res["tovar_turi"] == "AKB"

        inv = await db.get_inventory(rid)
        assert "AKB" in inv
        assert inv["AKB"] == 24.0

        added = await db.add_custom_type("test_cargo")
        assert added == "TEST_CARGO"
        types = await db.list_types()
        assert "TEST_CARGO" in types["custom"]
    finally:
        await db.delete_report(rid)
        try:
            await db.delete_custom_type("TEST_CARGO")
        except Exception:
            pass



