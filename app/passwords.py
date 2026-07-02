"""Password hashing for browser (username/password) login.

Stdlib-only PBKDF2-HMAC-SHA256 with a self-describing string format:
    pbkdf2_sha256$<iterations>$<salt_hex>$<hash_hex>

Generate a credential line for .env:
    python -m app.passwords <username>
"""
from __future__ import annotations

import getpass
import hashlib
import hmac
import secrets
import sys

# OWASP Password Storage guidance (2023+) for PBKDF2-HMAC-SHA256.
# The iteration count is stored per-hash, so raising this only affects newly
# generated credentials — existing hashes keep verifying with their own count.
ITERATIONS = 600_000
_ALGO = "pbkdf2_sha256"


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS)
    return f"{_ALGO}${ITERATIONS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time verify of a password against a stored PBKDF2 string."""
    try:
        algo, iters, salt_hex, hash_hex = stored.split("$")
        if algo != _ALGO:
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), int(iters))
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


def _main() -> None:
    username = sys.argv[1] if len(sys.argv) > 1 else input("username: ").strip()
    if not username or ":" in username or "," in username:
        print("username must be non-empty and contain no ':' or ','", file=sys.stderr)
        sys.exit(1)
    pw = getpass.getpass("password: ")
    if len(pw) < 4:
        print("password must be at least 4 characters (browser login uses a 4-digit PIN)", file=sys.stderr)
        sys.exit(1)
    if pw != getpass.getpass("repeat:   "):
        print("passwords do not match", file=sys.stderr)
        sys.exit(1)
    print("\nAdd this to ADMIN_CREDENTIALS in .env (comma-separate multiple users):\n")
    print(f"{username}:{hash_password(pw)}")


if __name__ == "__main__":
    _main()
