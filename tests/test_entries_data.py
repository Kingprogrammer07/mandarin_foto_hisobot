import time
import pytest
from app import db


@pytest.mark.asyncio
async def test_entries_data_structure():
    await db.init()
    rep = await db.create_report(f"Entries Filter Test Report {int(time.time() * 1000)}")
    rid = rep["id"]

    try:
        types_res = await db.list_types()
        types = types_res["types"]
        t1, t2 = types[0], types[1]

        # 1. Add reys entry
        r1 = await db.add_reys(rid, "tester", t1, 100.0, 2.5, 97.5, 0, 2.5)
        eid1 = r1["entry_id"]

        # 2. Add obshiy top entry
        r2 = await db.add_obshiy(rid, "tester", "top", "BOX-101", 45.0, 0.0, 45.0, 0, 1.2)
        eid2 = r2["entry_id"]

        # 3. Add adjust entry
        r3 = await db.adjust(rid, "tester", t1, t2, 10.0, 0)
        eid3 = r3["entry_id"]

        # Fetch reys entries
        reys_entries = await db.list_entries(rid, "reys")
        assert len(reys_entries) >= 1
        found_reys = next((e for e in reys_entries if e["id"] == eid1), None)
        assert found_reys is not None
        assert found_reys["tovar_turi"] == t1
        assert found_reys["weight"] == 100.0
        assert found_reys["coefficient"] == 2.5
        assert found_reys["net"] == 97.5

        # Fetch top entries
        top_entries = await db.list_entries(rid, "top")
        assert len(top_entries) >= 1
        found_top = next((e for e in top_entries if e["id"] == eid2), None)
        assert found_top is not None
        assert found_top["tovar_turi"] == "BOX-101"
        assert found_top["weight"] == 45.0
        assert found_top["box_weight"] == 1.2

        # Fetch adjust entries
        adj_entries = await db.list_entries(rid, "adjust")
        assert len(adj_entries) >= 1
        found_adj = next((e for e in adj_entries if e["id"] == eid3), None)
        assert found_adj is not None
        assert found_adj["from_type"] == t1
        assert found_adj["to_type"] == t2
        assert found_adj["weight"] == 10.0

    finally:
        await db.delete_report(rid)
