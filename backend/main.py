import os
import csv
import logging
import shutil
import tempfile
import threading
import time
from uuid import uuid4
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pypdf import PdfReader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_core.documents import Document
from langchain_core.messages import HumanMessage, SystemMessage
import requests
from langchain_openai import ChatOpenAI
from openai import BadRequestError
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams
from prompts import RAG_SYSTEM_PROMPT

# pypdf logs a warning per damaged object in some PDFs; thousands of lines slow the server down.
logging.getLogger("pypdf").setLevel(logging.ERROR)

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

class RateLimitExceeded(Exception):
    """Embedding provider is rate limiting us and waiting it out is impractical."""


class JobCancelled(Exception):
    """The user cancelled an in-flight upload."""


# Live progress for uploads, polled by the frontend via GET /progress/{job_id}.
_progress: dict[str, dict] = {}
_progress_lock = threading.Lock()
_MAX_TRACKED_JOBS = 50


def _set_progress(job_id, **fields):
    if not job_id:
        return
    with _progress_lock:
        if job_id not in _progress:
            if len(_progress) >= _MAX_TRACKED_JOBS:
                _progress.pop(next(iter(_progress)))
            _progress[job_id] = {"stage": "queued", "done": 0, "total": 0, "note": "", "cancelled": False}
        _progress[job_id].update(fields)


def _is_cancelled(job_id) -> bool:
    if not job_id:
        return False
    with _progress_lock:
        return bool(_progress.get(job_id, {}).get("cancelled"))


def _interruptible_sleep(seconds: float, job_id):
    end = time.time() + seconds
    while time.time() < end:
        if _is_cancelled(job_id):
            raise JobCancelled()
        time.sleep(min(1.0, max(0.0, end - time.time())))


# How long we are willing to keep waiting on rate limits for a single upload.
VOYAGE_MAX_WAIT_SECONDS = float(os.environ.get("VOYAGE_MAX_WAIT_MIN", "10")) * 60


def _voyage_api_request(payload: dict, job_id=None, remaining_batches: int = 1):
    api_key = os.environ.get("VOYAGE_API_KEY")
    if not api_key:
        raise RuntimeError("VOYAGE_API_KEY is not set in the environment.")

    url = os.environ.get("VOYAGE_API_URL", "https://api.voyageai.com/v1/embeddings")
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    # Voyage's free tier (no payment method) allows ~3 requests and ~10K tokens per
    # minute, so a 429 is expected on big uploads: wait it out, but give up early with a
    # clear message when the remaining work would take unreasonably long.
    max_attempts = 6
    for attempt in range(1, max_attempts + 1):
        if _is_cancelled(job_id):
            raise JobCancelled()
        resp = requests.post(url, json=payload, headers=headers, timeout=30)
        if resp.status_code == 429:
            try:
                detail = resp.json().get("detail", "")
            except ValueError:
                detail = ""
            reduced_tier = "reduced rate limits" in str(detail)
            est_wait = remaining_batches * 60
            if reduced_tier and est_wait > VOYAGE_MAX_WAIT_SECONDS:
                raise RateLimitExceeded(
                    f"Voyage's free tier (no payment method) allows about one embedding batch per minute, "
                    f"and this file still needs {remaining_batches} batches (~{round(est_wait / 60)} min). "
                    f"Add a payment method at https://dashboard.voyageai.com/ to lift the limit, "
                    f"or upload a smaller file."
                )
            if attempt < max_attempts:
                try:
                    wait = float(resp.headers.get("Retry-After", ""))
                except ValueError:
                    wait = 0
                wait = min(max(wait, 20 * attempt), 65)
                print(f"Voyage rate limit hit (429); retrying in {wait:.0f}s (attempt {attempt}/{max_attempts - 1})...")
                _set_progress(job_id, note=f"Rate limited by the embedding provider, waiting {wait:.0f}s...")
                _interruptible_sleep(wait, job_id)
                _set_progress(job_id, note="")
                continue
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


def get_embeddings_batch(texts: list[str], job_id=None):
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
        if _is_cancelled(job_id):
            raise JobCancelled()
        batch_number = i // batch_size + 1
        batch = texts[i : i + batch_size]
        print(f"Requesting embeddings for batch {i // batch_size + 1}/{total_batches}...")
        payload = {"model": "voyage-2", "input": batch}
        data = _voyage_api_request(payload, job_id=job_id, remaining_batches=total_batches - batch_number + 1)
        _set_progress(job_id, done=batch_number)

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
def _load_pdf_documents(file_path: str, source_name: str, job_id=None):
    """Read a PDF page by page so the UI can show progress and the user can cancel."""
    reader = PdfReader(file_path)
    total_pages = len(reader.pages)
    _set_progress(job_id, stage="parsing", done=0, total=total_pages)
    documents = []
    for page_number, page in enumerate(reader.pages):
        if _is_cancelled(job_id):
            raise JobCancelled()
        text = page.extract_text() or ""
        if text.strip():
            documents.append(Document(page_content=text, metadata={"source": source_name, "page": page_number}))
        if page_number % 3 == 0 or page_number == total_pages - 1:
            _set_progress(job_id, done=page_number + 1)
    return documents


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

def _index_documents(docs, source_name: str, upload_type: str, job_id=None):
    _set_progress(job_id, stage="chunking")
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000, chunk_overlap=200)
    chunks = text_splitter.split_documents(docs)

    if not chunks:
        return 0

    _set_progress(job_id, total_chunks=len(chunks))
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

def _fail_job(job_id, exc: Exception) -> HTTPException:
    """Record the failure for the progress poller and turn it into a clear HTTP error."""
    if isinstance(exc, HTTPException):
        _set_progress(job_id, stage="error", note=str(exc.detail))
        return exc
    if isinstance(exc, JobCancelled):
        _set_progress(job_id, stage="cancelled", note="Upload cancelled.")
        return HTTPException(status_code=409, detail="Upload cancelled.")
    if isinstance(exc, RateLimitExceeded):
        _set_progress(job_id, stage="error", note=str(exc))
        return HTTPException(status_code=429, detail=str(exc))
    _set_progress(job_id, stage="error", note=str(exc))
    return HTTPException(status_code=500, detail=f"Upload processing failed: {exc}")

@app.get("/progress/{job_id}")
async def get_progress(job_id: str):
    with _progress_lock:
        entry = _progress.get(job_id)
        return dict(entry) if entry else {"stage": "unknown", "done": 0, "total": 0, "note": ""}

@app.post("/cancel/{job_id}")
async def cancel_job(job_id: str):
    _set_progress(job_id, cancelled=True)
    return {"message": "Cancel requested."}

@app.post("/upload")
async def upload_file(file: UploadFile = File(...), job_id: str | None = Form(None)):
    tmp_file = None
    try:
        suffix = os.path.splitext(file.filename)[1] if file.filename else ".pdf"
        normalized_suffix = suffix.lower()
        if normalized_suffix not in {".pdf", ".csv"}:
            raise HTTPException(status_code=400, detail="Only PDF and CSV files are supported.")

        _set_progress(job_id, stage="parsing")
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tf:
            tmp_file = tf.name
            shutil.copyfileobj(file.file, tf)

        if normalized_suffix == ".csv":
            docs = await run_in_threadpool(_load_csv_documents, tmp_file, source_name=os.path.basename(file.filename) or "uploaded.csv")
            upload_type = "csv"
        else:
            docs = await run_in_threadpool(_load_pdf_documents, tmp_file, os.path.basename(file.filename) or "uploaded.pdf", job_id)
            upload_type = "pdf"

        if not docs:
            raise HTTPException(
                status_code=422,
                detail="No readable text was found in this file. If it is a scanned PDF (images of pages), it needs OCR first.",
            )

        total_chunks = await run_in_threadpool(_index_documents, docs, source_name=os.path.basename(file.filename) or "uploaded.file", upload_type=upload_type, job_id=job_id)
        _set_progress(job_id, stage="done", total_chunks=total_chunks)

        return {
            "message": "File ingested successfully.",
            "total_chunks": total_chunks,
        }
    except Exception as e:
        raise _fail_job(job_id, e)
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