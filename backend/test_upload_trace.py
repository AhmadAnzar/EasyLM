"""Upload a tiny CSV to a running backend and print the response.

Run from the backend folder:  python test_upload_trace.py
Set API_URL to test another address (default: http://localhost:8000).
"""
import os

import requests

base_url = os.environ.get("API_URL", "http://localhost:8000").rstrip("/")
csv_bytes = b"col1,col2\nval1,val2\nval3,val4\n"

try:
    resp = requests.post(f"{base_url}/upload", files={"file": ("test.csv", csv_bytes, "text/csv")}, timeout=120)
    print("Status code:", resp.status_code)
    print("Response body:", resp.text)
except Exception as e:
    print("Error:", e)
