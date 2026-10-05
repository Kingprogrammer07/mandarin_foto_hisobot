import io
import time
import httpx
import pytest
from app import config, passwords, security
from app.server import app

@pytest.mark.asyncio
async def test_api_routes():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as client:
        # 1. Healthz
        r = await client.get("/healthz")
        assert r.status_code == 200
        assert r.json().get("ok") is True

        # 2. Authentication setup
        username = list(config.ADMIN_CREDENTIALS.keys())[0] if config.ADMIN_CREDENTIALS else "testadmin"
        if not config.ADMIN_CREDENTIALS:
            config.ADMIN_CREDENTIALS[username] = passwords.hash_password("adminpass")
        token = security.issue_session(username)
        cookies = {"reys_session": token}
        headers = {"Origin": "https://testserver", "Referer": "https://testserver/"}

        # 3. Create report
        rep_name = f"Pytest Report {int(time.time() * 1000)}"
        r = await client.post("/api/reports", json={"name": rep_name}, cookies=cookies, headers=headers)
        assert r.status_code == 200
        rid = r.json()["report"]["id"]

        try:
            # 4. List types
            r = await client.get(f"/api/types?report_id={rid}", cookies=cookies)
            assert r.status_code == 200
            types = r.json()["types"]
            t1 = types[0]

            # 5. Submit reys with photo
            photo_bytes = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x01\x00`\x00`\x00\x00\xff\xdb\x00C\x00"
            files = [("photos", ("photo.jpg", io.BytesIO(photo_bytes), "image/jpeg"))]
            data = {
                "report_id": str(rid),
                "type": t1,
                "weight": "42.0",
                "coefficient": "2.0",
                "coefficient_mode": "fixed",
                "box_weight": "2.0",
            }
            r = await client.post("/api/report", data=data, files=files, cookies=cookies, headers=headers)
            assert r.status_code == 200
            entry_id = r.json()["entry_id"]

            # 6. Fetch photo
            r = await client.get(f"/api/entry/{entry_id}/photo/0", cookies=cookies)
            assert r.status_code in (200, 307)

            # 7. Check inventory
            r = await client.get(f"/api/inventory?report_id={rid}", cookies=cookies)
            assert r.status_code == 200
            inv = r.json()["inventory"]
            assert abs(inv[t1] - 40.0) < 1e-4

            # 8. Export Excel
            for ep in ("kargo", "obshiy", "summary"):
                r = await client.get(f"/api/export/{ep}?report_id={rid}", cookies=cookies)
                assert r.status_code == 200
                assert len(r.content) > 0

            # 9. Send bulk
            r = await client.post("/api/send-bulk", json={"report_id": rid, "kind": "reys", "mode": "unsent"}, cookies=cookies, headers=headers)
            assert r.status_code == 200
            assert r.json().get("queued") >= 1

        finally:
            await client.delete(f"/api/reports/{rid}", cookies=cookies, headers=headers)


@pytest.mark.asyncio
async def test_validation_error_formatting():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as client:
        username = list(config.ADMIN_CREDENTIALS.keys())[0] if config.ADMIN_CREDENTIALS else "testadmin"
        if not config.ADMIN_CREDENTIALS:
            config.ADMIN_CREDENTIALS[username] = passwords.hash_password("adminpass")
        token = security.issue_session(username)
        cookies = {"reys_session": token}
        headers = {"Origin": "https://testserver", "Referer": "https://testserver/"}

        # Send invalid string for photos instead of file
        data = {
            "report_id": "9999",
            "type": "akb",
            "weight": "10.0",
            "coefficient": "0",
            "coefficient_mode": "none",
            "photos": "[object Object]",
        }
        r = await client.post("/api/report", data=data, cookies=cookies, headers=headers)
        assert r.status_code == 422
        res = r.json()
        assert res.get("ok") is False
        assert isinstance(res.get("detail"), str)
        assert "Rasm" in res["detail"] or "fayli" in res["detail"]


@pytest.mark.asyncio
async def test_api_report_rename():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as client:
        username = list(config.ADMIN_CREDENTIALS.keys())[0] if config.ADMIN_CREDENTIALS else "testadmin"
        if not config.ADMIN_CREDENTIALS:
            config.ADMIN_CREDENTIALS[username] = passwords.hash_password("adminpass")
        token = security.issue_session(username)
        cookies = {"reys_session": token}
        headers = {"Origin": "https://testserver", "Referer": "https://testserver/"}

        ts = int(time.time() * 1000)
        # Create 2 reports
        r1 = await client.post("/api/reports", json={"name": f"ApiRep1 {ts}"}, cookies=cookies, headers=headers)
        assert r1.status_code == 200
        rid1 = r1.json()["report"]["id"]

        r2 = await client.post("/api/reports", json={"name": f"ApiRep2 {ts}"}, cookies=cookies, headers=headers)
        assert r2.status_code == 200
        rid2 = r2.json()["report"]["id"]

        try:
            # 1. Successful rename
            patch_res = await client.patch(f"/api/reports/{rid1}", json={"name": f"ApiRep1 Renamed {ts}"}, cookies=cookies, headers=headers)
            assert patch_res.status_code == 200
            assert patch_res.json()["report"]["name"] == f"ApiRep1 Renamed {ts}"

            # 2. Duplicate name -> 409
            dup_res = await client.patch(f"/api/reports/{rid1}", json={"name": f"ApiRep2 {ts}"}, cookies=cookies, headers=headers)
            assert dup_res.status_code == 409

            # 3. Empty name -> 400
            empty_res = await client.patch(f"/api/reports/{rid1}", json={"name": "   "}, cookies=cookies, headers=headers)
            assert empty_res.status_code == 400

            # 4. Non-existent report -> 404
            nf_res = await client.patch("/api/reports/9999999", json={"name": "New Name"}, cookies=cookies, headers=headers)
            assert nf_res.status_code == 404

            # 5. Check reports list returns max >= 200
            list_res = await client.get("/api/reports", cookies=cookies)
            assert list_res.status_code == 200
            assert list_res.json()["max"] >= 200
        finally:
            await client.delete(f"/api/reports/{rid1}", cookies=cookies, headers=headers)
            await client.delete(f"/api/reports/{rid2}", cookies=cookies, headers=headers)

