
# WebXR + Three.js Starter (VR • AR • Desktop • Mobile)

A production-ready base kit you can re-skin for any industry. It loads a GLB model, lights it with an HDRI, and supports VR/AR with graceful fallbacks.

## Quick Start
```bash
npm i
npm run dev
# Open the URL shown by Vite (HTTPS not required for localhost). On Quest Browser, use the IP version of that URL.
```

Drop your assets here:
```
public/assets/model.glb
public/assets/studio_small_03_1k.hdr
```

## Scripts
- `npm run dev` – Vite dev server (adds WebXR headers automatically).
- `npm run build` – production build.
- `npm run preview` – preview build.
- `npm run serve-https` – Express static server with WebXR headers.

## Deploy
- **Vercel:** included `vercel.json` adds required headers.
- **Netlify:** `netlify/_headers` included.
- **Nginx:** see `infra/nginx.conf` snippet.

## iOS AR Fallback
Immersive WebXR isn’t supported on iOS Safari. For AR, export a USDZ and integrate `<model-viewer>` or Quick Look. (This starter focuses on VR + Android AR.)

## Customize
Edit `src/ui/App.tsx` and `src/viewer.ts`. Convert this into a template system by reading scene/theme JSON and toggling features per client.
