import os
import csv
import shutil
import tempfile
from uuid import uuid4
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_core.documents import Document
from langchain_core.messages import HumanMessage, SystemMessage
import requests
from langchain_openai import ChatOpenAI
from openai import BadRequestError
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams
from prompts import RAG_SYSTEM_PROMPT


app = FastAPI(title="Assignment 03 - RAG")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def _load_env_file(path: str = ".env"):
    try:
        with open(path, "r", encoding="utf-8") as env_file:
            for line in env_file:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip())
    except FileNotFoundError:
        pass

_load_env_file()

def _voyage_api_request(payload: dict):
    api_key = os.environ.get("VOYAGE_API_KEY")
    if not api_key:
        raise RuntimeError("VOYAGE_API_KEY is not set in the environment.")

    url = os.environ.get("VOYAGE_API_URL", "https://api.voyageai.com/v1/embeddings")
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    resp = requests.post(url, json=payload, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


@app.on_event("startup")
def _startup_checks():
    voyage_url = os.environ.get("VOYAGE_API_URL", "https://api.voyageai.com/v1/embeddings")
    print(f"Voyage endpoint configured: {voyage_url}")
    api_key_set = bool(os.environ.get("VOYAGE_API_KEY"))
    print(f"VOYAGE_API_KEY set: {api_key_set}")


def get_embedding(text: str):
    """Return a single embedding vector for `text` using Voyage AI."""
    if isinstance(text, (list, tuple)):
        raise ValueError("get_embedding expects a single string. Use get_embeddings_batch for lists.")
    payload = {"model": "voyage-2", "input": text}
    data = _voyage_api_request(payload)

    if isinstance(data, dict) and "data" in data and isinstance(data["data"], list):
        first = data["data"][0]
        if isinstance(first, dict) and "embedding" in first:
            return first["embedding"]
    if isinstance(data, dict) and "embedding" in data:
        return data["embedding"]

    raise RuntimeError("Unexpected response from Voyage API when requesting embedding.")


def get_embeddings_batch(texts: list[str]):
    """Return list of embedding vectors for a list of texts using Voyage AI.

    This splits the texts into smaller batches (e.g., size 32) to prevent
    rate-limit errors or timeouts, then returns the combined list of embeddings.
    """
    if not texts:
        return []

    batch_size = 32
    all_embeddings = []
    total_batches = -(-len(texts) // batch_size)

    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        print(f"Requesting embeddings for batch {i // batch_size + 1}/{total_batches}...")
        payload = {"model": "voyage-2", "input": batch}
        data = _voyage_api_request(payload)
        
        if isinstance(data, dict) and "data" in data and isinstance(data["data"], list):
            for item in data["data"]:
                if isinstance(item, dict) and "embedding" in item:
                    all_embeddings.append(item["embedding"])
                else:
                    raise RuntimeError("Unexpected batch item shape from Voyage API")
        elif isinstance(data, dict) and "embedding" in data:
            all_embeddings.append(data["embedding"])
        else:
            raise RuntimeError("Unexpected response from Voyage API for batch embeddings.")

    return all_embeddings

if not os.environ.get("GITHUB_TOKEN"):
    print("Warning: GITHUB_TOKEN is missing.")

llm = None
def _get_llm():
    global llm
    if llm is None:
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError("GROQ_API_KEY is not set in the environment or .env file.")
        llm = ChatOpenAI(
            model="llama-3.3-70b-versatile",
            api_key=api_key,
            base_url="https://api.groq.com/openai/v1",
            temperature=0.1,
        )
    return llm

QDRANT_COLLECTION = os.environ.get("QDRANT_COLLECTION", "easy_lm_docs")
TOP_K = 2

qdrant_client = None

def _get_qdrant_client():
    global qdrant_client
    if qdrant_client is None:
        QDRANT_URL = os.environ.get("QDRANT_URL")
        QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY")
        
        if not QDRANT_URL or not QDRANT_API_KEY or QDRANT_URL.lower() == "local":
            print("Using local persistent Qdrant storage at ./qdrant_db")
            qdrant_client = QdrantClient(path="./qdrant_db")
            return qdrant_client
            
        try:
            print(f"Attempting to connect to Qdrant Cloud: {QDRANT_URL}")
            clean_url = QDRANT_URL.replace(":6333", "").replace(":6334", "")
            client = QdrantClient(url=clean_url, port=6334, api_key=QDRANT_API_KEY, check_compatibility=False)
            # Quick check to verify connection
            client.collection_exists(collection_name=QDRANT_COLLECTION)
            qdrant_client = client
            print("Successfully connected to Qdrant Cloud!")
        except Exception as e:
            print(f"Warning: Qdrant Cloud connection failed ({e}). Falling back to local persistent Qdrant storage at ./qdrant_db")
            qdrant_client = QdrantClient(path="./qdrant_db")
    return qdrant_client

class QueryRequest(BaseModel):
    query: str

class TextUploadRequest(BaseModel):
    text: str

def _load_csv_documents(file_path: str, source_name: str):
    with open(file_path, "r", encoding="utf-8-sig", newline="") as csv_file:
        sample = csv_file.read(4096)
        csv_file.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample) if sample.strip() else csv.excel
        except csv.Error:
            dialect = csv.excel
        try:
            has_header = csv.Sniffer().has_header(sample) if sample.strip() else False
        except csv.Error:
            has_header = False

        documents = []
        if has_header:
            reader = csv.DictReader(csv_file, dialect=dialect)
            for row_index, row in enumerate(reader, start=1):
                row_items = [f"{key}: {value}" for key, value in row.items() if key and value not in (None, "")]
                row_text = "; ".join(row_items).strip()
                if row_text:
                    documents.append(
                        Document(
                            page_content=row_text,
                            metadata={"source": source_name, "row_number": row_index},
                        )
                    )
        else:
            reader = csv.reader(csv_file, dialect=dialect)
            for row_index, row in enumerate(reader, start=1):
                row_text = ", ".join(cell for cell in row if cell).strip()
                if row_text:
                    documents.append(
                        Document(
                            page_content=row_text,
                            metadata={"source": source_name, "row_number": row_index},
                        )
                    )
    return documents

def _index_documents(docs, source_name: str, upload_type: str):
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000, chunk_overlap=200)
    chunks = text_splitter.split_documents(docs)

    if not chunks:
        return 0

    client = _get_qdrant_client()

    chunk_texts = [doc.page_content for doc in chunks]
    print("Requesting embeddings from Voyage AI...")
    chunk_vectors = get_embeddings_batch(chunk_texts)
    print("Embeddings received from Voyage AI.")

    # ensure collection exists with correct vector size
    vector_size = len(chunk_vectors[0]) if chunk_vectors else 0
    if not client.collection_exists(collection_name=QDRANT_COLLECTION):
        client.create_collection(
            collection_name=QDRANT_COLLECTION,
            vectors_config=VectorParams(
                size=vector_size,
                distance=Distance.COSINE,
            ),
        )

    # To avoid duplicate chunks if the same filename is uploaded again,
    # delete any existing points with this source_name.
    from qdrant_client.models import Filter, FieldCondition, MatchValue
    try:
        client.delete(
            collection_name=QDRANT_COLLECTION,
            points_selector=Filter(
                must=[
                    FieldCondition(
                        key="source_name",
                        match=MatchValue(value=source_name)
                    )
                ]
            )
        )
    except Exception as e:
        print(f"Notice: Failed to clear old vectors for '{source_name}': {e}")

    points = []
    for index, (chunk, vector) in enumerate(zip(chunks, chunk_vectors)):
        payload = {
            "text": chunk.page_content,
            "source_name": source_name,
            "upload_type": upload_type,
            "chunk_index": index,
        }
        for key, value in (chunk.metadata or {}).items():
            if isinstance(value, (str, int, float, bool)):
                payload[f"meta_{key}"] = value

        points.append(
            PointStruct(
                id=str(uuid4()),
                vector=vector,
                payload=payload,
            )
        )

    # Upsert points in batches to prevent payload errors on large docs
    batch_size = 100
    for i in range(0, len(points), batch_size):
        client.upsert(collection_name=QDRANT_COLLECTION, points=points[i:i+batch_size], wait=True)
        
    return len(chunks)

def _search_qdrant(query_vector, top_k: int):
    client = _get_qdrant_client()
    response = client.query_points(
        collection_name=QDRANT_COLLECTION,
        query=query_vector,
        limit=top_k,
        with_payload=True,
    )
    return getattr(response, "points", response)

class DeleteSourceRequest(BaseModel):
    source_name: str

@app.post("/delete-source")
async def delete_source(req: DeleteSourceRequest):
    client = _get_qdrant_client()
    from qdrant_client.models import Filter, FieldCondition, MatchValue
    try:
        client.delete(
            collection_name=QDRANT_COLLECTION,
            points_selector=Filter(
                must=[
                    FieldCondition(
                        key="source_name",
                        match=MatchValue(value=req.source_name)
                    )
                ]
            )
        )
        return {"message": f"Source '{req.source_name}' deleted successfully."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete source: {e}")

@app.post("/clear")
async def clear_data():
    client = _get_qdrant_client()
    try:
        client.delete_collection(collection_name=QDRANT_COLLECTION)
        return {"message": "All data cleared successfully."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to clear data: {e}")

@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    tmp_file = None
    try:
        suffix = os.path.splitext(file.filename)[1] if file.filename else ".pdf"
        normalized_suffix = suffix.lower()
        if normalized_suffix not in {".pdf", ".csv"}:
            raise HTTPException(status_code=400, detail="Only PDF and CSV files are supported.")

        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tf:
            tmp_file = tf.name
            shutil.copyfileobj(file.file, tf)

        if normalized_suffix == ".csv":
            docs = await run_in_threadpool(_load_csv_documents, tmp_file, source_name=os.path.basename(file.filename) or "uploaded.csv")
            upload_type = "csv"
        else:
            loader = PyPDFLoader(tmp_file)
            docs = await run_in_threadpool(loader.load)
            upload_type = "pdf"

        total_chunks = await run_in_threadpool(_index_documents, docs, source_name=os.path.basename(file.filename) or "uploaded.file", upload_type=upload_type)

        return {
            "message": "File ingested successfully.",
            "total_chunks": total_chunks,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload processing failed: {e}")
    finally:
        try:
            if tmp_file and os.path.exists(tmp_file):
                os.remove(tmp_file)
        except Exception:
            pass

@app.post("/upload-text")
async def upload_text(payload: TextUploadRequest):
    text = payload.text.strip()
    if not text:
        return {"message": "No text provided.", "total_chunks": 0}

    docs = [Document(page_content=text, metadata={"source": "clipboard-text"})]
    total_chunks = await run_in_threadpool(_index_documents, docs, source_name="clipboard-text", upload_type="text")
    return {
        "message": "Text ingested successfully.",
        "total_chunks": total_chunks,
    }

@app.post("/query")
async def query_document(req: QueryRequest):
    try:
        query_vector = get_embedding(req.query)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error embedding query: {e}")
    try:
        search_result = _search_qdrant(query_vector, TOP_K)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error searching Qdrant: {e}")

    if not search_result:
        return {"answer": "No relevant information found. Try a better question."}

    searched_chunks = []
    for result in search_result:
        payload = None
        if hasattr(result, "payload"):
            payload = result.payload
        elif isinstance(result, dict):
            payload = result.get("payload") or result

        if isinstance(payload, dict):
            text = payload.get("text")
            if text:
                searched_chunks.append(text)
        elif isinstance(payload, str) and payload.strip():
            searched_chunks.append(payload)

    if not searched_chunks:
        return {"answer": "No relevant information found. Try a better question."}
    
    context = "\n\n".join(searched_chunks)
    system_prompt = RAG_SYSTEM_PROMPT.format(
        instructions=f"DOCUMENT CONTEXT:\n{context}\n\nUser Query: {req.query}\n\nProvide a concise answer in 2-5 sentences."
    )
    
    messages = [
        SystemMessage(content=system_prompt),
        HumanMessage(content=f"Query: {req.query}"),
    ]

    try:
        llm_instance = _get_llm()
        response = llm_instance.invoke(messages)
    except BadRequestError as error:
        if "content_filter" in str(error):
            return {"answer": "The backend blocked this request.", "source_chunks": searched_chunks}
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
    return {
        "answer": response.content.strip(),
        "source_chunks": searched_chunks
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "10000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port)