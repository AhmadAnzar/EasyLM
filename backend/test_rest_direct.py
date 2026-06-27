from qdrant_client import QdrantClient

url = "https://9b0fb569-58de-4672-80d8-2007ae05fc69.eu-central-1-0.aws.cloud.qdrant.io"
# The first API key
first_key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIiwic3ViamVjdCI6ImFwaS1rZXk6ZTQ3NTMzMDctNDJiZi00ZDI0LWJiNzEtMzdiMDM4YTEzMDU5In0.xSewpJhauLAOw_V1izxZuIpKnVYYUZHHv-raRSUc2r4"

print("Testing first key with URL:", url)
try:
    client = QdrantClient(url=url, api_key=first_key)
    collections = client.get_collections()
    print("SUCCESS! collections:", collections)
except Exception as e:
    print("FAILED:", type(e).__name__, str(e))
