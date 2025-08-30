// src/viewer.ts
import * as THREE from 'three'
import { VRButton } from 'three/examples/jsm/webxr/VRButton'
import { ARButton } from 'three/examples/jsm/webxr/ARButton'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'

// ---- constants
const DEFAULT_EYE_HEIGHT = 1
const LOOK_SENS_MOUSE = 0.0022
const LOOK_SENS_TOUCH = 0.005
const LOOK_PITCH_LIMIT = THREE.MathUtils.degToRad(85)
const MOVE_SPEED = 2.0
const CLICK_PX = 6
const CLICK_MS = 300

// ---- zoom constants (SNAP between extremes)
const FOV_MIN = 18
const FOV_MID = 35
const FOV_MAX = 100
const WHEEL_ZOOM_SNAP = true
const PINCH_ZOOM_SNAP = true

// ---- temps
const _tmpV = new THREE.Vector3()
const _mouseNDC = new THREE.Vector2(0, 0)

// Fallback floor helpers (only used if NO navmesh provided)
const _floorPlane = new THREE.Plane()
const _floorPosWS = new THREE.Vector3()
const _floorNormalWS = new THREE.Vector3(0, 1, 0)
const _ray = new THREE.Ray()

// --- navmesh state
let navmeshGroup: THREE.Group | null = null        // holds baked navmesh meshes (always visible for raycast)
let navmeshMinY: number | null = null              // global lowest Y
let navmeshDebugWireOn = false

// keep the same transform we applied to the model so navmesh can match it
const _modelAppliedXform = new THREE.Matrix4().identity()

export type ViewerConfig = {
  modelUrl?: string
  hdriUrl?: string
  showHDRIBackground?: boolean
  initialModelScale?: number
  initialEyeHeight?: number
  navmeshUrl?: string // teleport only on this imported mesh
}

export type ViewerHandle = {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  rig: THREE.Group
  model?: THREE.Object3D
  mount: HTMLElement
  toggleBackground: () => void
  resetView: () => void
  setModelScale: (s: number) => void
  setEyeHeight: (h: number) => void
  setFovPreset: (deg: number | null) => void
}

function safeAppend(parent: HTMLElement | DocumentFragment | null, el: HTMLElement) {
  try { parent?.appendChild(el) } catch (e) { console.warn('[viewer] append failed', e) }
}

export async function initViewer(mount: HTMLElement, cfg: ViewerConfig = {}): Promise<ViewerHandle> {
  // --- renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(Math.max(1, mount.clientWidth), Math.max(1, mount.clientHeight))
  renderer.setClearColor(0x0f1116, 1)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0
  renderer.xr.enabled = true
  try { renderer.xr.setReferenceSpaceType?.('local-floor') } catch {}
  mount.appendChild(renderer.domElement)
  renderer.domElement.style.cursor = 'grab'
  renderer.domElement.style.touchAction = 'none'

  // VR/AR buttons (never throw)
  try {
    const vrBtn = VRButton.createButton(renderer)
    Object.assign(vrBtn.style, { position: 'fixed', right: '12px', bottom: '12px' })
    safeAppend(document.body, vrBtn)
  } catch (e) { console.warn('[viewer] VRButton failed', e) }
  try {
    const arBtn = ARButton.createButton(renderer, { requiredFeatures: [] })
    Object.assign(arBtn.style, { position: 'fixed', right: '12px', bottom: '56px' })
    safeAppend(document.body, arBtn)
  } catch (e) { console.warn('[viewer] ARButton failed', e) }

  // --- scene & camera
  const scene  = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(
    FOV_MID,
    Math.max(1, mount.clientWidth) / Math.max(1, mount.clientHeight),
    0.01,
    2000
  )
  let targetFov = FOV_MAX // start at widest
  camera.fov = targetFov
  camera.updateProjectionMatrix()

  // first-person rig (yaw/pitch)
  const rig = new THREE.Group(); rig.name = 'Rig'
  scene.add(rig)
  const yaw = new THREE.Object3D(); const pitch = new THREE.Object3D()
  rig.add(yaw); yaw.add(pitch); pitch.add(camera)
  let eyeHeight = cfg.initialEyeHeight ?? DEFAULT_EYE_HEIGHT
  pitch.position.y = eyeHeight
  rig.position.set(0, 0, 2.5)
  camera.position.set(0, 0, 0)

  // world node
  const world = new THREE.Group(); world.name = 'World'
  scene.add(world)

  // lighting
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 0.6))
  const dir = new THREE.DirectionalLight(0xffffff, 0.7)
  dir.position.set(5, 10, 5)
  dir.castShadow = false
  scene.add(dir)

  // PMREM/HDRI
  const pmrem = new THREE.PMREMGenerator(renderer)
  pmrem.compileEquirectangularShader()

  let envMap: THREE.Texture | null = null
  async function loadHDRI(url: string) {
    try {
      const hdr = await new RGBELoader().loadAsync(url)
      envMap = pmrem.fromEquirectangular(hdr).texture
      hdr.dispose()
      scene.environment = envMap
      if (cfg.showHDRIBackground) scene.background = envMap
    } catch (e) { console.warn('[viewer] HDRI load failed (continuing)', e) }
  }

  // ---- fallback floor (used only if no navmesh)
  let navFloor: THREE.Mesh<THREE.PlaneGeometry, THREE.Material> | null = null
  function ensureNavFloor() {
    if (navFloor) return
    const mat = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0, side: THREE.DoubleSide })
    mat.depthWrite = false
    mat.colorWrite = false
    const geom = new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2)
    navFloor = new THREE.Mesh(geom, mat)
    navFloor.name = 'TeleportFloor'
    world.add(navFloor)
  }
  function stickNavFloorToMinY() {
    if (!navFloor) return
    const box = new THREE.Box3().setFromObject(world)
    if (!isFinite(box.min.y) || !isFinite(box.max.y)) {
      navFloor.position.set(0, 0, 0)
    } else {
      const y = (box.min.y || 0) + 0.002
      navFloor.position.set(0, y, 0)
      const sizeX = Math.max(50, (box.max.x - box.min.x) * 1.5)
      const sizeZ = Math.max(50, (box.max.z - box.min.z) * 1.5)
      navFloor.scale.set(sizeX / 200, 1, sizeZ / 200)
    }
    navFloor.updateWorldMatrix(true, false)
    _floorPosWS.setFromMatrixPosition(navFloor.matrixWorld)
    _floorNormalWS.set(0, 1, 0).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(navFloor.matrixWorld))
    _floorPlane.setFromNormalAndCoplanarPoint(_floorNormalWS, _floorPosWS)
  }

  // model
  let model: THREE.Object3D | undefined
  let modelXform = new THREE.Matrix4().identity()

  async function loadGLB(url: string) {
    const gltf = await new GLTFLoader().loadAsync(url)
    const root = gltf.scene as THREE.Object3D
    model = root

    const spawn = root.getObjectByName('SpawnPoint')
    if (spawn) {
      // Align model to spawn
      spawn.updateWorldMatrix(true, true)
      const inv = new THREE.Matrix4().copy(spawn.matrixWorld).invert()
      root.applyMatrix4(inv)
      modelXform.copy(inv)
      _modelAppliedXform.copy(inv) // << remember model transform
    } else {
      // Auto center/scale
      const box = new THREE.Box3().setFromObject(root)
      const size = new THREE.Vector3(); box.getSize(size)
      const center = new THREE.Vector3(); box.getCenter(center)
      const targetHeight = 1.5
      const s = targetHeight / (size.y || 1.0)
      const T1 = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z)
      const S  = new THREE.Matrix4().makeScale(s, s, s)
      const T2 = new THREE.Matrix4().makeTranslation(0, 1.0, 0)
      modelXform.copy(T2).multiply(S).multiply(T1)
      root.applyMatrix4(modelXform)
      _modelAppliedXform.copy(modelXform) // << remember model transform
    }

    world.add(root)
    ensureNavFloor()
    stickNavFloorToMinY()
  }

  // NAVMESH loader (supports many child meshes). Keeps meshes VISIBLE for raycast, but non-rendering.
  async function loadNavmesh(url: string) {
    try {
      const gltf = await new GLTFLoader().loadAsync(url)

      // group to hold baked world-space copies (added to scene root)
      navmeshGroup = new THREE.Group()
      scene.add(navmeshGroup)

      let minY = Number.POSITIVE_INFINITY
      gltf.scene.updateWorldMatrix(true, true)
      gltf.scene.traverse((o: THREE.Object3D) => {
        if ((o as THREE.Mesh).isMesh) {
          const m = o as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>
          // Bake world transform AND the model's applied transform (so both align!)
          const baked = m.geometry.clone()
          baked.applyMatrix4(m.matrixWorld)
          baked.applyMatrix4(_modelAppliedXform) // << align to model transform
          baked.deleteAttribute('normal')
          baked.deleteAttribute('uv')
          baked.computeBoundingBox()
          if (baked.boundingBox) minY = Math.min(minY, baked.boundingBox.min.y)

          const mat = new THREE.MeshBasicMaterial({
            color: 0x00ffff,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.0,           // invisible by default
          })
          // make it non-rendering but raycastable
          ;(mat as any).colorWrite = false
          ;(mat as any).depthWrite = false

          const bakedMesh = new THREE.Mesh(baked, mat)
          bakedMesh.visible = true          // ALWAYS visible so Raycaster will hit it
          bakedMesh.renderOrder = -1
          navmeshGroup!.add(bakedMesh)
        }
      })

      if (navmeshGroup.children.length === 0) {
        console.warn('[viewer] navmesh has no mesh geometry')
        scene.remove(navmeshGroup)
        navmeshGroup = null
        navmeshMinY = null
        return
      }

      navmeshMinY = isFinite(minY) ? minY : null

      // DEBUG wireframe toggle (N)
      window.addEventListener('keydown', (ev) => {
        if (ev.key.toLowerCase() === 'n' && navmeshGroup) {
          navmeshDebugWireOn = !navmeshDebugWireOn
          navmeshGroup.children.forEach((c) => {
            const mesh = c as THREE.Mesh
            const mat = mesh.material as THREE.MeshBasicMaterial
            mat.wireframe = navmeshDebugWireOn
            mat.opacity = navmeshDebugWireOn ? 0.3 : 0.0
            ;(mat as any).colorWrite = navmeshDebugWireOn
            ;(mat as any).depthWrite = navmeshDebugWireOn
            mesh.visible = true // keep true for raycast
          })
          console.log(`[viewer] Navmesh debug ${navmeshDebugWireOn ? 'ON' : 'OFF'} minY:`, navmeshMinY)
        }
      })
    } catch (e) {
      console.warn('[viewer] navmesh load failed', e)
      if (navmeshGroup) scene.remove(navmeshGroup)
      navmeshGroup = null
      navmeshMinY = null
    }
  }

  if (cfg.hdriUrl) await loadHDRI(cfg.hdriUrl)
  if (cfg.modelUrl) {
    try { await loadGLB(cfg.modelUrl) }
    catch (e) {
      console.warn('[viewer] model load failed; using fallback cube', e)
      const cube = new THREE.Mesh(
        new THREE.BoxGeometry(1,1,1),
        new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.5 })
      )
      cube.position.y = 1.0
      world.add(cube)
      model = cube
      _modelAppliedXform.identity() // fallback: no special transform
    }
  } else {
    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(1,1,1),
      new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.5 })
    )
    cube.position.y = 1.0
    world.add(cube)
    model = cube
    _modelAppliedXform.identity()
  }

  if (cfg.navmeshUrl) await loadNavmesh(cfg.navmeshUrl)

  // scale
  let currentScale = cfg.initialModelScale ?? 1
  world.scale.setScalar(currentScale)

  // sync navmesh scale with world scale (so hits line up with scaled model)
  function syncNavmeshScale(k: number) {
    if (!navmeshGroup) return
    navmeshGroup.scale.setScalar(k)
    navmeshGroup.updateMatrixWorld(true)
  }
  syncNavmeshScale(currentScale)

  // ensure floor exists and is positioned after initial content (fallback only)
  ensureNavFloor()
  stickNavFloorToMinY()

  // --- reticle marker (aim ring)
  const aimPoint = new THREE.Vector3()
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.15, 0.22, 40, 1),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.7, side: THREE.DoubleSide })
  )
  ;(marker.material as THREE.MeshBasicMaterial).depthTest = false
  marker.renderOrder = 999
  marker.visible = false
  scene.add(marker)

  // --- standing indicator (glow sprite + subtle point light)
  const standLight = new THREE.PointLight(0xffaa66, 0.9, 3.0, 2.0)
  standLight.position.set(0, 0.1, 0)
  scene.add(standLight)

  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128
    const ctx = c.getContext('2d')!
    const r = 64; const g = ctx.createRadialGradient(r, r, 0, r, r, r)
    g.addColorStop(0.0, 'rgba(255,255,255,0.85)')
    g.addColorStop(0.25, 'rgba(255,200,100,0.55)')
    g.addColorStop(0.6, 'rgba(255,150,50,0.25)')
    g.addColorStop(1.0, 'rgba(255,120,20,0.0)')
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(r, r, r, 0, Math.PI * 2); ctx.fill()
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex
  })()
  const standGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending
  }))
  standGlow.center.set(0.5, 0.5)
  standGlow.scale.set(0.6, 0.6, 1)
  standGlow.renderOrder = 998
  scene.add(standGlow)

  // --- movement and input
  const raycaster = new THREE.Raycaster()
  const clock = new THREE.Clock()
  let moveTarget: THREE.Vector3 | null = null

  const down = new THREE.Vector2()
  let downTime = 0
  let dragging = false

  // desktop drag-to-look
  let isDragging = false
  let lastX = 0, lastY = 0

  window.addEventListener('mousemove', (e) => {
    const rect = renderer.domElement.getBoundingClientRect()
    _mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    _mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  }, { passive: true })

  renderer.domElement.addEventListener('mousedown', (e) => {
    if (renderer.xr.isPresenting) return
    isDragging = true
    lastX = e.clientX; lastY = e.clientY
    down.set(e.clientX, e.clientY); downTime = performance.now()
    dragging = false
    renderer.domElement.style.cursor = 'grabbing'
  })

  renderer.domElement.addEventListener('mousemove', (e) => {
    if (renderer.xr.isPresenting) return
    if (!isDragging) return
    const dx = e.clientX - lastX
    const dy = e.clientY - lastY
    lastX = e.clientX; lastY = e.clientY
    yaw.rotation.y -= dx * LOOK_SENS_MOUSE
    pitch.rotation.x -= dy * LOOK_SENS_MOUSE
    pitch.rotation.x = THREE.MathUtils.clamp(pitch.rotation.x, -LOOK_PITCH_LIMIT, LOOK_PITCH_LIMIT)
    dragging = true
  })

  renderer.domElement.addEventListener('mouseup', (e) => {
    if (renderer.xr.isPresenting) return
    const dx = e.clientX - down.x, dy = e.clientY - down.y
    const dtUp = performance.now() - downTime
    const moved = (dx*dx + dy*dy) > (CLICK_PX*CLICK_PX)
    if (!moved && dtUp <= CLICK_MS && marker.visible) {
      moveTo(aimPoint, true)
      standLight.intensity = 1.6
    }
    isDragging = false
    dragging = false
    renderer.domElement.style.cursor = 'grab'
  })

  renderer.domElement.addEventListener('mouseleave', () => {
    isDragging = false
    dragging = false
    renderer.domElement.style.cursor = 'grab'
  })

  // --- SNAP ZOOM for trackpad/mouse wheel
  renderer.domElement.addEventListener('wheel', (e) => {
    e.preventDefault()
    if (!WHEEL_ZOOM_SNAP) return
    if (e.deltaY < 0) targetFov = FOV_MIN // zoom in
    else if (e.deltaY > 0) targetFov = FOV_MAX // zoom out
  }, { passive: false })

  // touch drag-to-look + two-finger pinch-to-zoom (SNAP + revert on release)
  let lastTouchX = 0, lastTouchY = 0
  let pinchActive = false
  let pinchStartDist = 0
  let pinchSnapChosen = false

  function dist2D(ax: number, ay: number, bx: number, by: number) {
    const dx = ax - bx, dy = ay - by
    return Math.hypot(dx, dy)
  }

  renderer.domElement.addEventListener('touchstart', (e) => {
    if (renderer.xr.isPresenting) return

    if (e.touches.length === 1) {
      const t = e.touches[0]
      lastTouchX = t.clientX; lastTouchY = t.clientY
      down.set(t.clientX, t.clientY); downTime = performance.now(); dragging = false
      pinchActive = false
      pinchSnapChosen = false
    } else if (e.touches.length >= 2) {
      const a = e.touches[0], b = e.touches[1]
      pinchStartDist = dist2D(a.clientX, a.clientY, b.clientX, b.clientY)
      pinchActive = true
      pinchSnapChosen = false
      dragging = false
    }
  }, { passive: true })

  renderer.domElement.addEventListener('touchmove', (e) => {
    if (renderer.xr.isPresenting) return

    if (e.touches.length >= 2 && pinchActive && PINCH_ZOOM_SNAP) {
      const a = e.touches[0], b = e.touches[1]
      const d = dist2D(a.clientX, a.clientY, b.clientX, b.clientY)
      if (!pinchSnapChosen) {
        // Apart => zoom in (FOV_MIN). Together => zoom out (FOV_MAX).
        targetFov = (d > pinchStartDist) ? FOV_MIN : FOV_MAX
        pinchSnapChosen = true
      }
      return
    }

    if (e.touches.length === 1) {
      const t = e.touches[0]
      const dx = t.clientX - lastTouchX, dy = t.clientY - lastTouchY
      lastTouchX = t.clientX; lastTouchY = t.clientY
      yaw.rotation.y -= dx * LOOK_SENS_TOUCH
      pitch.rotation.x -= dy * LOOK_SENS_TOUCH
      pitch.rotation.x = THREE.MathUtils.clamp(pitch.rotation.x, -LOOK_PITCH_LIMIT, LOOK_PITCH_LIMIT)
      dragging = true
    }
  }, { passive: true })

  renderer.domElement.addEventListener('touchend', (e) => {
    if (renderer.xr.isPresenting) return

    if (e.touches.length < 2 && pinchActive) {
      // Pinch released: revert back to baseline widest FOV ("lowest zoom")
      targetFov = FOV_MAX
      pinchActive = false
      pinchSnapChosen = false
    }

    const dtUp = performance.now() - downTime
    const isClick = !dragging && dtUp <= CLICK_MS
    if (isClick && marker.visible) {
      moveTo(aimPoint, true)
      standLight.intensity = 1.6
    }
    dragging = false
  }, { passive: true })

  // XR controllers: select to go
  const tmpMat = new THREE.Matrix4()
  function addController(index: number) {
    const ctrl = renderer.xr.getController(index)
    rig.add(ctrl)
    const rayGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,-1)])
    const rayLine = new THREE.Line(rayGeom, new THREE.LineBasicMaterial()); rayLine.scale.z = 10
    ctrl.add(rayLine)

    const onSelect = () => { if (marker.visible) { moveTo(aimPoint, false); standLight.intensity = 1.6 } }
    ctrl.addEventListener('select', onSelect)
    ctrl.addEventListener('selectstart', onSelect)

    ;(ctrl.userData as any).updateAim = () => {
      tmpMat.identity().extractRotation(ctrl.matrixWorld)
      _ray.origin.setFromMatrixPosition(ctrl.matrixWorld)
      _ray.direction.set(0, 0, -1).applyMatrix4(tmpMat).normalize()

      if (navmeshGroup) {
        const rc = new THREE.Raycaster(_ray.origin, _ray.direction)
        const hit = rc.intersectObjects(navmeshGroup.children, true)[0]
        updateMarkerFromHit(hit)
        return
      }
      // fallback only when NO navmesh
      if (navFloor) {
        const hitPoint = new THREE.Vector3()
        if (_ray.intersectPlane(_floorPlane, hitPoint)) {
          updateMarkerFromHit({ point: hitPoint } as unknown as THREE.Intersection)
          return
        }
      }
      updateMarkerFromHit(undefined)
    }
  }
  addController(0); addController(1)

  // resize
  function doResize() {
    const w = Math.max(1, mount.clientWidth)
    const h = Math.max(1, mount.clientHeight)
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    stickNavFloorToMinY()
  }
  window.addEventListener('resize', doResize)

  // helpers
  function updateMarkerFromHit(hit?: THREE.Intersection) {
    if (hit && navmeshGroup) {
      aimPoint.copy(hit.point)
      marker.quaternion.set(0, 0, 0, 1)
      // ⬇️ show marker exactly where you’re aiming (local surface height)
      const y = hit.point.y + 0.01
      marker.position.set(aimPoint.x, y, aimPoint.z)
      marker.visible = true
    } else if (!navmeshGroup && hit) {
      aimPoint.copy((hit as any).point)
      marker.quaternion.set(0, 0, 0, 1)
      const y = navFloor ? navFloor.position.y + 0.01 : 0.01
      marker.position.set(aimPoint.x, y, aimPoint.z)
      marker.visible = true
    } else {
      marker.visible = false
    }
  }
  

  function moveTo(target: THREE.Vector3, smooth: boolean) {
    const dest = target.clone()
    // ⬇️ still clamp to lowest Y on the navmesh
    const y = navmeshGroup ? (navmeshMinY ?? target.y) : (navFloor ? _floorPosWS.y : 0)
    dest.y = y
  
    if (!smooth || renderer.xr.isPresenting) {
      rig.position.set(dest.x, 0, dest.z)
      moveTarget = null
    } else {
      moveTarget = dest
    }
  }
  

  // --- UI: FOV toggle buttons (18° / 35°)
  let activePreset: 18 | 35 | null = null
  const ui = document.createElement('div')
  ui.style.position = 'fixed'
  ui.style.top = '12px'
  ui.style.right = '12px'
  ui.style.display = 'flex'
  ui.style.gap = '8px'
  ui.style.zIndex = '1000'
  const mkBtn = (label: string) => {
    const b = document.createElement('button')
    b.textContent = label
    Object.assign(b.style, {
      font: '12px/1.2 system-ui, -apple-system, Segoe UI, Inter, Roboto, sans-serif',
      background: '#1f2937',
      color: '#e5e7eb',
      border: '1px solid #374151',
      borderRadius: '10px',
      padding: '8px 10px',
      cursor: 'pointer'
    } as Partial<CSSStyleDeclaration>)
    b.onmouseenter = () => { b.style.background = '#111827' }
    b.onmouseleave = () => { b.style.background = (b.dataset.active === '1' ? '#0b1220' : '#1f2937') }
    return b
  }

  const btn18 = mkBtn('18°')
  const btn35 = mkBtn('35°')
  ui.append(btn18, btn35)
  safeAppend(document.body, ui)

  function updateBtnStates() {
    const setActive = (btn: HTMLButtonElement, on: boolean) => {
      btn.dataset.active = on ? '1' : '0'
      btn.style.background = on ? '#0b1220' : '#1f2937'
      btn.style.border = on ? '1px solid #60a5fa' : '1px solid #374151'
      btn.style.color = on ? '#bfdbfe' : '#e5e7eb'
    }
    setActive(btn18, activePreset === 18)
    setActive(btn35, activePreset === 35)
  }

  function setFovPresetInternal(deg: number | null) {
    if (deg === 18) { activePreset = 18 as const; targetFov = FOV_MIN }
    else if (deg === 35) { activePreset = 35 as const; targetFov = FOV_MID }
    else { activePreset = null; targetFov = FOV_MAX }
    updateBtnStates()
  }

  btn18.addEventListener('click', () => {
    setFovPresetInternal(activePreset === 18 ? null : 18)
  })
  btn35.addEventListener('click', () => {
    setFovPresetInternal(activePreset === 35 ? null : 35)
  })
  updateBtnStates()

  // --- animation loop
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta())

    // aim reticle (desktop) — NAVMESH FIRST (no plane if navmesh exists)
    if (!renderer.xr.isPresenting) {
      raycaster.setFromCamera(_mouseNDC, camera)

      if (navmeshGroup) {
        const hit = raycaster.intersectObjects(navmeshGroup.children, true)[0]
        updateMarkerFromHit(hit)
      } else if (navFloor) {
        _ray.origin.copy(raycaster.ray.origin)
        _ray.direction.copy(raycaster.ray.direction).normalize()
        const hitPoint = new THREE.Vector3()
        if (_ray.intersectPlane(_floorPlane, hitPoint)) {
          updateMarkerFromHit({ point: hitPoint } as unknown as THREE.Intersection)
        } else {
          updateMarkerFromHit(undefined)
        }
      } else {
        updateMarkerFromHit(undefined)
      }
    } else {
      const c0 = renderer.xr.getController(0), c1 = renderer.xr.getController(1)
      ;(c0 as any)?.userData?.updateAim?.()
      ;(c1 as any)?.userData?.updateAim?.()
    }

    // smooth move
    if (moveTarget) {
      _tmpV.copy(moveTarget).sub(rig.position); _tmpV.y = 0
      const dist = _tmpV.length()
      const step = MOVE_SPEED * dt
      const tol = Math.max(0.05, step)
      if (dist <= tol) {
        rig.position.set(moveTarget.x, 0, moveTarget.z)
        moveTarget = null
        standLight.intensity = 1.6
      } else {
        _tmpV.normalize().multiplyScalar(step)
        rig.position.add(new THREE.Vector3(_tmpV.x, 0, _tmpV.z))
      }
    }

    // standing indicator: base Y from navmesh lowest level (if available)
    {
      const baseY =
        navmeshGroup
          ? ((navmeshMinY ?? 0) + 0.01)
          : (navFloor ? (navFloor.position.y + 0.01) : 0.01)

      const t = performance.now() * 0.002
      const s = 0.55 + 0.10 * (0.5 + 0.5 * Math.sin(t))
      standGlow.position.set(rig.position.x, baseY, rig.position.z)
      standGlow.scale.set(s, s, 1)
      standLight.position.set(rig.position.x, baseY + 0.15, rig.position.z)
      const baseIntensity = 1.0 + 0.25 * (0.5 + 0.5 * Math.sin(t))
      standLight.intensity += (baseIntensity - standLight.intensity) * Math.min(1, dt * 5)
    }

    // marker pulse
    if (marker.visible) {
      const s = 1 + 0.05 * Math.sin(performance.now() * 0.006)
      marker.scale.set(s, 1, s)
    }

    // smooth FOV tween toward target
    {
      const diff = targetFov - camera.fov
      if (Math.abs(diff) > 0.01) {
        camera.fov += diff * Math.min(1, dt * 8)
        camera.fov = THREE.MathUtils.clamp(camera.fov, Math.min(FOV_MIN, FOV_MID), FOV_MAX)
        camera.updateProjectionMatrix()
      }
    }

    renderer.render(scene, camera)
  })

  // public API
  function setModelScale(s: number) {
    const k = Math.max(0.001, s)
    world.scale.setScalar(k)
    // keep navmesh aligned with model/world scale
    if (navmeshGroup) {
      navmeshGroup.scale.setScalar(k)
      navmeshGroup.updateMatrixWorld(true)
    }
    stickNavFloorToMinY()
  }

  function setEyeHeight(h: number) {
    const clamped = THREE.MathUtils.clamp(h, 0.5, 2.5)
    eyeHeight = clamped
    pitch.position.y = eyeHeight
  }

  function setFovPreset(deg: number | null) {
    setFovPresetInternal(deg)
  }

  // FOV UI state init
  _mouseNDC.set(0, 0)

  return {
    renderer, scene, camera, rig, model, mount,
    toggleBackground: () => { if (envMap) scene.background = scene.background ? null : envMap },
    resetView: () => { rig.position.set(0,0,2.5); yaw.rotation.set(0,0,0); pitch.rotation.set(0,0,0) },
    setModelScale,
    setEyeHeight,
    setFovPreset,
  }
}

export function disposeViewer(h: ViewerHandle) {
  try {
    h.renderer.setAnimationLoop(null)
    h.renderer.dispose()
    if (h.mount.contains(h.renderer.domElement)) h.mount.removeChild(h.renderer.domElement)
  } catch (e) { console.warn('[viewer] dispose error', e) }
}
