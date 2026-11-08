"""Check that the Qdrant instance configured in backend/.env is reachable.

Run from the backend folder:  python test_rest_direct.py
"""
import os

from qdrant_client import QdrantClient


def load_env(path=".env"):
    values = {}
    try:
        with open(path, "r", encoding="utf-8") as env_file:
            for line in env_file:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    values[key.strip()] = value.strip()
    except FileNotFoundError:
        pass
    return values


env = load_env()
url = os.environ.get("QDRANT_URL") or env.get("QDRANT_URL")
api_key = os.environ.get("QDRANT_API_KEY") or env.get("QDRANT_API_KEY")

if not url or url.lower() == "local":
    raise SystemExit("QDRANT_URL is not set (or is 'local'), so there is no cloud cluster to test.")

print("Testing connection to:", url)
try:
    client = QdrantClient(url=url, api_key=api_key, check_compatibility=False)
    print("SUCCESS! collections:", client.get_collections())
except Exception as e:
    print("FAILED:", type(e).__name__, str(e))
