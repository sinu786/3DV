
import React, { useEffect, useRef, useState } from 'react'
import { initViewer, disposeViewer, type ViewerHandle } from '../viewer'

export default function App() {
  const mountRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<string>('Loading...')
  const [handle, setHandle] = useState<ViewerHandle | null>(null)

  useEffect(() => {
    let cleanup = () => {}
    (async () => {
      if (!mountRef.current) return
      try {
        const h = await initViewer(mountRef.current, {
          modelUrl: '/assets/model.glb',
          hdriUrl: '/assets/studio_small_03_1k.hdr',
          showHDRIBackground: true
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
  }, [])

  return (
    <>
      <div className="ui">
        <div><strong>WebXR Starter</strong></div>
        <div>Status: {status}</div>
        <div style={{ marginTop: 8 }}>
          <button onClick={() => handle?.toggleBackground?.()}>
            Toggle HDRI Background
          </button>
          <button style={{ marginLeft: 8 }} onClick={() => handle?.resetCamera?.()}>
            Reset Camera
          </button>
        </div>
      </div>
      <div className="footer">VR • AR • Desktop • Mobile — Three.js</div>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
    </>
  )
}
