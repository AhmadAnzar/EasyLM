# EasyLM RAG App

EasyLM is a document question answering app built as a simple NotebookLM style RAG system.

A user can upload a file, the app processes the content, stores it in a vector database, and then answers questions using the most relevant retrieved chunks.

## What the app does

The app supports these flows:

- Upload a PDF file
- Upload a CSV file
- Paste plain text into the app
- Chunk the content
- Create embeddings for the content
- Store the embeddings in Qdrant
- Retrieve the most relevant chunks for a question
- Generate an answer from the retrieved context
- Show source citations under assistant answers

## Project structure

- backend: FastAPI server that handles upload, indexing, and question answering
- frontend: React and Vite user interface

## Requirements

You need these before running the app:

- Python 3.10 or later
- Node.js 18 or later
- A Groq API key (answer generation, free tier is enough)
- Optional: a Qdrant Cloud cluster. Without one, the backend stores vectors locally in `backend/qdrant_db`

Embeddings run locally by default (a small ONNX model via `fastembed`), so no embedding API key is needed and there are no rate limits. The first start downloads the model (about 90 MB) into `backend/.model_cache`.

## Backend setup

Go to the backend folder and install the Python dependencies:

```
cd backend
pip install -r requirements.txt
```

Copy `.env.example` to `.env` and fill in these values (the backend loads `backend/.env` automatically):

- GROQ_API_KEY
- GROQ_MODEL, optional, defaults to `openai/gpt-oss-120b`
- EMBEDDING_PROVIDER, optional: `local` (default) or `voyage`. With `voyage`, also set VOYAGE_API_KEY. Voyage's free tier allows about one batch of chunks per minute, so large files are very slow
- LOCAL_EMBEDDING_MODEL, optional, defaults to `sentence-transformers/all-MiniLM-L6-v2` (fast). `BAAI/bge-small-en-v1.5` is a slower alternative
- QDRANT_URL and QDRANT_API_KEY, optional. Leave them out, or set QDRANT_URL to `local`, to use local storage. If the cloud cluster cannot be reached, the backend falls back to local storage and logs a warning
- QDRANT_COLLECTION, optional, defaults to `easy_lm_docs`. With local embeddings the model name is appended to it, because vectors from different embedding models cannot be mixed

Start the backend from the backend folder:

```
uvicorn main:app --port 8000
```

The backend runs on port 8000. (`python main.py` also defaults to 8000, and honours the PORT variable if set.)

Large files take a while to embed. The app shows live progress while indexing and has a Cancel button.

## Frontend setup

Go to the frontend folder, install the Node dependencies, and start the dev server:

```
cd frontend
npm install
npm run dev
```

The frontend runs on port 5173 (Vite uses the next free port if that one is taken) and calls the backend at `http://localhost:8000`. To use a different backend, set `VITE_API_BASE_URL` in `frontend/.env`.

## How to use the app

1. Open the frontend in your browser.
2. Add a source: drop a PDF or CSV anywhere on the page, use Add Sources, or paste text (up to 5 sources at once).
3. Wait for the content to be processed and indexed. The dialog shows the real progress and you can cancel.
4. Ask a question about the uploaded content. Follow-up questions work because the recent conversation is sent along.
5. Read the answer and check the source citations.

## Backend API

- `POST /upload` and `POST /upload-text` index a file or some text (an optional `job_id` lets the client follow progress)
- `GET /progress/{job_id}` and `POST /cancel/{job_id}` report on and stop an upload in progress
- `POST /query` answers a question (optionally with the recent chat `history`)
- `GET /sources` lists what is indexed, with the chunk count per source
- `POST /delete-source` removes one source and `POST /clear` removes everything

## Supported input

The app currently supports:

- PDF files
- CSV files
- Plain text pasted into the app

## Notes

- The app uses Qdrant for vector storage and retrieval.
- The backend uses retrieved chunks when generating answers.
- The app is designed to answer from the uploaded content, not from general model memory alone.
- The chat and the source list are saved in the browser, and uploaded PDFs are kept there too (IndexedDB) so their preview survives a refresh. On load the source list is synced with what is actually indexed, so nothing indexed is ever missing from the list.
- If a required environment variable is missing, the backend may not be able to complete uploads or query requests.

## Assignment fit

This project matches the main goals of the assignment:

- A user can upload a document
- The system chunks, embeds, stores, retrieves, and answers questions
- Answers are grounded in retrieved document content
- The app works with new files it has not seen before

