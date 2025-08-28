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

// ---- temps
const _normal = new THREE.Vector3(0, 1, 0)
const _quat   = new THREE.Quaternion()
const _mat3   = new THREE.Matrix3()
const _tmpV   = new THREE.Vector3()
const _mouseNDC = new THREE.Vector2(0, 0)

// Floor aiming helpers (solve click offset by intersecting an infinite plane)
const _floorPlane = new THREE.Plane()
const _floorPosWS = new THREE.Vector3()
const _floorNormalWS = new THREE.Vector3(0, 1, 0)
const _ray = new THREE.Ray()

// --- helper: make a soft radial glow texture for a Sprite
function makeGlowTexture(size = 128) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const r = size * 0.5
  const g = ctx.createRadialGradient(r, r, 0, r, r, r)
  g.addColorStop(0.0, 'rgba(255,255,255,0.85)')
  g.addColorStop(0.25, 'rgba(255,200,100,0.55)')
  g.addColorStop(0.6, 'rgba(255,150,50,0.25)')
  g.addColorStop(1.0, 'rgba(255,120,20,0.0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(r, r, r, 0, Math.PI * 2)
  ctx.fill()
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export type ViewerConfig = {
  modelUrl?: string
  hdriUrl?: string
  showHDRIBackground?: boolean
  initialModelScale?: number
  initialEyeHeight?: number  // NEW (optional)
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
  setEyeHeight: (h: number) => void   // NEW
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

  // Drag-to-look (keep cursor)
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
    70,
    Math.max(1, mount.clientWidth) / Math.max(1, mount.clientHeight),
    0.01,
    2000
  )

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

  // ---- teleport floor (sticks to model minY)
  let navFloor: THREE.Mesh<THREE.PlaneGeometry, THREE.Material> | null = null
  function ensureNavFloor() {
    if (navFloor) return
    const mat = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0, side: THREE.DoubleSide })
    mat.depthWrite = false
    mat.colorWrite = false
    const geom = new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2)
    navFloor = new THREE.Mesh(geom, mat)
    navFloor.name = 'TeleportFloor'
    // parent to world so it scales with the model
    world.add(navFloor)
  }

  function stickNavFloorToMinY() {
    if (!navFloor) return
    const box = new THREE.Box3().setFromObject(world)
    if (!isFinite(box.min.y) || !isFinite(box.max.y)) {
      navFloor.position.set(0, 0, 0)
    } else {
      // snap just above the lowest point
      const y = (box.min.y || 0) + 0.002
      navFloor.position.set(0, y, 0)

      // scale coverage based on model footprint (with margin)
      const sizeX = Math.max(50, (box.max.x - box.min.x) * 1.5)
      const sizeZ = Math.max(50, (box.max.z - box.min.z) * 1.5)
      // base plane is 200x200
      navFloor.scale.set(sizeX / 200, 1, sizeZ / 200)
    }
    // keep world-space plane in sync
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
      spawn.updateWorldMatrix(true, true)
      const inv = new THREE.Matrix4().copy(spawn.matrixWorld).invert()
      root.applyMatrix4(inv)
      modelXform.copy(inv)
    } else {
      // fit height ≈ 1.5m
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
    }

    world.add(root)

    // ensure + stick floor after adding model
    ensureNavFloor()
    stickNavFloorToMinY()
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
    }
  } else {
    // fallback cube if no model
    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(1,1,1),
      new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.5 })
    )
    cube.position.y = 1.0
    world.add(cube)
    model = cube
  }

  // scale
  let currentScale = cfg.initialModelScale ?? 1
  world.scale.setScalar(currentScale)

  // ensure floor exists and is positioned after initial content
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

  const glowTex = makeGlowTexture()
  const standGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
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

  renderer.domElement.addEventListener('mousedown', (e) => {
    if (renderer.xr.isPresenting) return
    isDragging = true
    lastX = e.clientX; lastY = e.clientY
    down.set(e.clientX, e.clientY); downTime = performance.now()
    dragging = false
    renderer.domElement.style.cursor = 'grabbing'

    // keep NDC fresh
    const rect = renderer.domElement.getBoundingClientRect()
    _mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    _mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  })

  // update NDC every mousemove; rotate only while dragging
  renderer.domElement.addEventListener('mousemove', (e) => {
    const rect = renderer.domElement.getBoundingClientRect()
    _mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    _mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1

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
    const dt = performance.now() - downTime
    const moved = (dx*dx + dy*dy) > (CLICK_PX*CLICK_PX)
    if (!moved && dt <= CLICK_MS && marker.visible) {
      moveTo(aimPoint, true)
      standLight.intensity = 1.6
    }
    isDragging = false
    dragging = false
    renderer.domElement.style.cursor = 'grab'

    // keep NDC fresh
    const rect = renderer.domElement.getBoundingClientRect()
    _mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    _mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  })

  renderer.domElement.addEventListener('mouseleave', () => {
    isDragging = false
    dragging = false
    renderer.domElement.style.cursor = 'grab'
  })

  // touch drag-to-look + tap-to-go
  let lastTouchX = 0, lastTouchY = 0
  renderer.domElement.addEventListener('touchstart', (e) => {
    if (renderer.xr.isPresenting) return
    const t = e.touches[0]
    lastTouchX = t.clientX; lastTouchY = t.clientY
    down.set(t.clientX, t.clientY); downTime = performance.now(); dragging = false
  }, { passive: true })

  renderer.domElement.addEventListener('touchmove', (e) => {
    if (renderer.xr.isPresenting) return
    const t = e.touches[0]
    const dx = t.clientX - lastTouchX, dy = t.clientY - lastTouchY
    lastTouchX = t.clientX; lastTouchY = t.clientY
    yaw.rotation.y -= dx * LOOK_SENS_TOUCH
    pitch.rotation.x -= dy * LOOK_SENS_TOUCH
    pitch.rotation.x = THREE.MathUtils.clamp(pitch.rotation.x, -LOOK_PITCH_LIMIT, LOOK_PITCH_LIMIT)
    dragging = true
  }, { passive: true })

  renderer.domElement.addEventListener('touchend', () => {
    if (renderer.xr.isPresenting) return
    const dt = performance.now() - downTime
    const isClick = !dragging && dt <= CLICK_MS
    if (isClick && marker.visible) {
      moveTo(aimPoint, true)
      standLight.intensity = 1.6
    }
    dragging = false
  })

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

      if (navFloor) {
        const hitPoint = new THREE.Vector3()
        if (_ray.intersectPlane(_floorPlane, hitPoint)) {
          updateMarkerFromHit({
            point: hitPoint,
            face: null,
            object: navFloor
          } as unknown as THREE.Intersection)
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
    // floor may need to be recomputed due to world scaling/layout changes from CSS
    stickNavFloorToMinY()
  }
  window.addEventListener('resize', doResize)

  // helpers
  function updateMarkerFromHit(hit?: THREE.Intersection) {
    if (hit) {
      aimPoint.copy(hit.point)
      // for plane hits we use up-normal
      marker.quaternion.set(0, 0, 0, 1)
      marker.position.set(aimPoint.x, (navFloor ? navFloor.position.y + 0.01 : 0.01), aimPoint.z)
      marker.visible = true
    } else {
      marker.visible = false
    }
  }

  function moveTo(target: THREE.Vector3, smooth: boolean) {
    const dest = target.clone()
    // Align to plane Y (rig itself stays at Y=0 for simplicity)
    const planeY = _floorPosWS.y
    dest.y = planeY

    if (!smooth || renderer.xr.isPresenting) {
      rig.position.set(dest.x, 0, dest.z)
      moveTarget = null
    } else {
      moveTarget = dest
    }
  }

  // --- animation loop
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta())

    // aim reticle (desktop): ray from camera through mouse -> infinite floor plane
    if (!renderer.xr.isPresenting) {
      if (navFloor) {
        raycaster.setFromCamera(_mouseNDC, camera)
        _ray.origin.copy(raycaster.ray.origin)
        _ray.direction.copy(raycaster.ray.direction).normalize()

        const hitPoint = new THREE.Vector3()
        if (_ray.intersectPlane(_floorPlane, hitPoint)) {
          updateMarkerFromHit({
            point: hitPoint,
            face: null,
            object: navFloor
          } as unknown as THREE.Intersection)
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
        standLight.intensity = 1.6 // pop on arrival
      } else {
        _tmpV.normalize().multiplyScalar(step)
        rig.position.add(new THREE.Vector3(_tmpV.x, 0, _tmpV.z))
      }
    }

    // --- update standing indicator (glow + light)
    {
      const baseY = navFloor ? (navFloor.position.y + 0.01) : 0.01
      const t = performance.now() * 0.002
      const s = 0.55 + 0.10 * (0.5 + 0.5 * Math.sin(t)) // 0.55..0.65

      standGlow.position.set(rig.position.x, baseY, rig.position.z)
      standGlow.scale.set(s, s, 1)

      // decay light back toward ~1.0 after pops
      standLight.position.set(rig.position.x, baseY + 0.15, rig.position.z)
      const baseIntensity = 1.0 + 0.25 * (0.5 + 0.5 * Math.sin(t))
      standLight.intensity += (baseIntensity - standLight.intensity) * Math.min(1, dt * 5)
    }

    // marker pulse
    if (marker.visible) {
      const s = 1 + 0.05 * Math.sin(performance.now() * 0.006)
      marker.scale.set(s, 1, s)
    }

    renderer.render(scene, camera)
  })

  // public API
  function setModelScale(s: number) {
    const k = Math.max(0.001, s)
    world.scale.setScalar(k)
    stickNavFloorToMinY()
  }

  function setEyeHeight(h: number) {
    // clamp to a sensible range in meters
    const clamped = THREE.MathUtils.clamp(h, 0.5, 2.5)
    eyeHeight = clamped
    pitch.position.y = eyeHeight
  }

  // initialize mouse at center to avoid NaN rays before first move
  _mouseNDC.set(0, 0)

  return {
    renderer, scene, camera, rig, model, mount,
    toggleBackground: () => { if (envMap) scene.background = scene.background ? null : envMap },
    resetView: () => { rig.position.set(0,0,2.5); yaw.rotation.set(0,0,0); pitch.rotation.set(0,0,0) },
    setModelScale,
    setEyeHeight, // NEW
  }
}

export function disposeViewer(h: ViewerHandle) {
  try {
    h.renderer.setAnimationLoop(null)
    h.renderer.dispose()
    if (h.mount.contains(h.renderer.domElement)) h.mount.removeChild(h.renderer.domElement)
  } catch (e) { console.warn('[viewer] dispose error', e) }
}
