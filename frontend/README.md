# EasyLM frontend

React + Vite interface for EasyLM. It talks to the FastAPI backend in `../backend` (see the main README
for the full setup).

## Run it

```
npm install
npm run dev
```

The dev server starts on port 5173 (Vite picks the next free port if that one is taken) and calls the
backend at `http://localhost:8000`. To use another backend, copy `.env.example` to `.env` and set
`VITE_API_BASE_URL`.

## Other scripts

- `npm run build` creates a production build in `dist/`
- `npm run preview` serves that build locally
- `npm run lint` runs ESLint

## What lives where

- `src/App.jsx` is the router: `/` landing page, `/login`, `/demo` (read-only guest workspace) and
  `/u/:username/workspace/:n` (a logged-in user's own workspace)
- `src/components/Workspace.jsx` holds one workspace's state: sources, chat, uploads, drag and drop
- `src/components/` also has the landing page, the login page, the page layout (`HomePage`), the Add Sources dialog and the animated `Modal`
- `src/auth/` keeps who is logged in; `src/api.js` sends the session token and turns server errors into messages
- `src/fileStore.js` keeps uploaded PDFs in the browser (IndexedDB) so previews survive a refresh
- The chat and the source list are saved in `localStorage` per workspace, and on load the source list is
  synced with what is actually indexed in the database
- `vercel.json` rewrites every path to `index.html` so deep links work on refresh
