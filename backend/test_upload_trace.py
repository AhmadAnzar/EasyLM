import requests

url = "http://localhost:10000/upload"
with open("test.csv", "w") as f:
    f.write("col1,col2\nval1,val2\nval3,val4\n")

try:
    with open("test.csv", "rb") as f:
        files = {"file": ("test.csv", f, "text/csv")}
        resp = requests.post(url, files=files)
        print("Status code:", resp.status_code)
        print("Response body:", resp.text)
except Exception as e:
    print("Error:", e)
finally:
    import os
    if os.path.exists("test.csv"):
        os.remove("test.csv")
