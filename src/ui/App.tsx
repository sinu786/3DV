// src/ui/App.tsx
import React, { useEffect, useRef, useState } from 'react'
import { initViewer, disposeViewer, type ViewerHandle } from '../viewer'

export default function App() {
  const mountRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<string>('Loading…')
  const [handle, setHandle] = useState<ViewerHandle | null>(null)
  const [scale, setScale] = useState<number>(0.25) // UI scale (25% by default)

  useEffect(() => {
    let cleanup = () => {}
    ;(async () => {
      if (!mountRef.current) return
      try {
        const h = await initViewer(mountRef.current, {
          modelUrl: '/assets/model.glb',
          hdriUrl: '/assets/studio_small_03_1k.hdr',
          showHDRIBackground: true,
          initialModelScale: scale, // start with UI scale
        })
        setHandle(h)
        setStatus('Ready')
        cleanup = () => disposeViewer(h)
      } catch (e) {
        console.error(e)
        setStatus('Failed to initialize viewer')
      }
    })()
    return () => cleanup()
  }, []) // init once

  // Keep scene scale in sync when user drags the slider
  useEffect(() => {
    handle?.setModelScale?.(scale)
  }, [scale, handle])

  return (
    <>
      {/* Overlay UI */}
      <div
        className="ui"
        style={{
          position: 'fixed',
          top: 12,
          left: 12,
          zIndex: 10,
          padding: 12,
          background: 'rgba(0,0,0,0.45)',
          color: '#fff',
          borderRadius: 8,
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          backdropFilter: 'blur(6px)',
          maxWidth: 360,
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 4 }}>WebXR Starter</div>
        <div style={{ opacity: 0.9 }}>Status: {status}</div>

        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={() => handle?.toggleBackground?.()}
            style={btnStyle}
            disabled={!handle}
          >
            Toggle HDRI Background
          </button>
          <button
            onClick={() => handle?.resetView?.()}
            style={btnStyle}
            disabled={!handle}
          >
            Reset Camera
          </button>
        </div>

        {/* Scale control */}
        <div style={{ marginTop: 12 }}>
          <label htmlFor="scale" style={{ display: 'block', marginBottom: 6 }}>
            Model Scale: <code>{scale.toFixed(2)}×</code>
          </label>
          <input
            id="scale"
            type="range"
            min={0.05}
            max={2}
            step={0.01}
            value={scale}
            onChange={(e) => setScale(parseFloat(e.target.value))}
            style={{ width: '100%' }}
            disabled={!handle}
          />
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85, lineHeight: 1.35 }}>
            • Drag to look · Click to move<br />
            • VR/AR: use controller trigger to move
          </div>
        </div>
      </div>

      <div
        className="footer"
        style={{
          position: 'fixed',
          right: 12,
          bottom: 12,
          zIndex: 10,
          padding: '6px 10px',
          background: 'rgba(0,0,0,0.35)',
          color: '#fff',
          borderRadius: 6,
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          fontSize: 12,
        }}
      >
        VR • AR • Desktop • Mobile — Three.js
      </div>

      {/* Mount target */}
      <div
        ref={mountRef}
        style={{
          position: 'fixed',
          inset: 0,
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          background: '#0f1116',
        }}
      />
    </>
  )
}

const btnStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,0.2)',
  background: 'rgba(255,255,255,0.06)',
  color: '#fff',
  cursor: 'pointer',
}
