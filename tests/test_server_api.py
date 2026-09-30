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
