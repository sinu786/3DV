// src/viewer.ts
import * as THREE from 'three'
import { VRButton } from 'three/examples/jsm/webxr/VRButton'
import { ARButton } from 'three/examples/jsm/webxr/ARButton'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import { Pathfinding } from 'three-pathfinding'

// ---------- tuning ----------
const EYE_HEIGHT = 1.6
const LOOK_SENS_MOUSE = 0.0022  // radians per pixel
const LOOK_SENS_TOUCH = 0.005   // radians per pixel (drag)
const LOOK_PITCH_LIMIT = THREE.MathUtils.degToRad(85) // up/down clamp
const MOVE_SPEED = 2.0          // m/s for smooth desktop/mobile move
const CLICK_PX = 6              // click vs drag threshold
const CLICK_MS = 300            // click max press time
// ----------------------------

// scratch utils to reduce GC
const _normal = new THREE.Vector3()
const _quat   = new THREE.Quaternion()
const _mat3   = new THREE.Matrix3()
const _dir    = new THREE.Vector3()
const _tmpV   = new THREE.Vector3()
const _tmpV2  = new THREE.Vector3()

export type ViewerConfig = {
  modelUrl?: string
  hdriUrl?: string
  navmeshUrl?: string
  showHDRIBackground?: boolean
}

export type ViewerHandle = {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  rig: THREE.Group
  model?: THREE.Object3D
  toggleBackground: () => void
  resetView: () => void
  mount: HTMLElement
}

export async function initViewer(mount: HTMLElement, cfg: ViewerConfig = {}): Promise<ViewerHandle> {
  // --- Renderer / XR ---
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(mount.clientWidth, mount.clientHeight)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0
  renderer.xr.enabled = true
  renderer.xr.setReferenceSpaceType('local-floor')
  mount.appendChild(renderer.domElement)

  // XR buttons
  const vrBtn = VRButton.createButton(renderer)
  const arBtn = ARButton.createButton(renderer, { requiredFeatures: [] })
  Object.assign(vrBtn.style, { position: 'fixed', right: '12px', bottom: '12px' })
  Object.assign(arBtn.style, { position: 'fixed', right: '12px', bottom: '56px' })
  document.body.appendChild(vrBtn)
  document.body.appendChild(arBtn)

  // --- Scene / Camera rig (first-person) ---
  const scene  = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(70, mount.clientWidth / mount.clientHeight, 0.01, 1000)

  const rig = new THREE.Group()
  rig.name = 'Rig'
  scene.add(rig)

  // Yaw (horizontal), Pitch (vertical)
  const yaw = new THREE.Object3D(); yaw.name = 'Yaw'
  const pitch = new THREE.Object3D(); pitch.name = 'Pitch'
  rig.add(yaw)
  yaw.add(pitch)
  pitch.add(camera)

  // eye height
  yaw.position.set(0, 0, 0)
  pitch.position.set(0, EYE_HEIGHT, 0)
  camera.position.set(0, 0, 0)

  // initial view
  rig.position.set(0, 0, 2.5)
  yaw.rotation.y = 0
  pitch.rotation.x = 0

  // Lights
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 0.4))

  // PMREM
  const pmrem = new THREE.PMREMGenerator(renderer)
  pmrem.compileEquirectangularShader()

  // Invisible ground (fallback ray/teleport target)
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x111416, transparent: true, opacity: 0 })
  groundMat.depthWrite = false
  groundMat.colorWrite = false
  groundMat.side = THREE.DoubleSide
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2),
    groundMat
  )
  ground.name = 'TeleportGround'
  ;(ground as any).userData.teleportable = true
  scene.add(ground)

  // Teleportable set
  const teleportables: THREE.Object3D[] = [ground]

  // Navmesh
  const pathfinder = new Pathfinding()
  const ZONE = 'level'
  let modelXform = new THREE.Matrix4().identity()
  let navReady = false
  let navRayMesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material> | null = null

  // Marker (center reticle target)
  const aimPoint = new THREE.Vector3()
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.15, 0.22, 40, 1),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, side: THREE.DoubleSide })
  )
  ;(marker.material as THREE.MeshBasicMaterial).depthTest = false
  marker.renderOrder = 999
  marker.visible = false
  scene.add(marker)

  // Assets
  let envMap: THREE.Texture | null = null
  let model: THREE.Object3D | undefined
  let mixer: THREE.AnimationMixer | undefined

  async function loadHDRI(url: string) {
    try {
      const hdr = await new RGBELoader().loadAsync(url)
      envMap = pmrem.fromEquirectangular(hdr).texture
      hdr.dispose()
      scene.environment = envMap
      if (cfg.showHDRIBackground) scene.background = envMap
    } catch (e) {
      console.warn('[HDRI] Failed to load, continuing without environment.', e)
    }
  }

  async function loadGLB(url: string) {
    const loader = new GLTFLoader()
    const gltf = await loader.loadAsync(url)
    const root = gltf.scene as THREE.Object3D
    model = root

    if (gltf.animations?.length) {
      mixer = new THREE.AnimationMixer(root)
      gltf.animations.forEach((clip: THREE.AnimationClip) => {
        const action = mixer!.clipAction(clip)
        action.stop(); action.enabled = false
      })
    }

    // SpawnPoint alignment or fallback normalize
    const spawn = root.getObjectByName('SpawnPoint')
    if (spawn) {
      spawn.updateWorldMatrix(true, true)
      const inv = new THREE.Matrix4().copy(spawn.matrixWorld).invert()
      root.applyMatrix4(inv)
      modelXform.copy(inv)
    } else {
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

    root.traverse((o: any) => {
      if (o.isMesh) {
        o.castShadow = true
        o.receiveShadow = true
        if (o.material) o.material.envMapIntensity = 1.0
      }
      if (o.isMesh && (o.name?.toLowerCase?.().includes('floor') || o.userData?.teleportable)) {
        teleportables.push(o)
      }
    })

    scene.add(root)
  }

  async function loadNavMesh(url: string) {
    const gltf = await new GLTFLoader().loadAsync(url)

    let nm: THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]> | undefined
    gltf.scene.traverse((o: any) => {
      if (o.isMesh && (o.name === 'NavMesh' || o.userData?.navmesh)) nm = o
    })
    if (!nm) { console.warn('[NavMesh] No mesh named "NavMesh" found'); return }

    const geom = (nm.geometry as THREE.BufferGeometry).clone()
    nm.updateWorldMatrix(true, true)
    geom.applyMatrix4(nm.matrixWorld)
    geom.applyMatrix4(modelXform) // align with model transform

    const zone = Pathfinding.createZone(geom)
    pathfinder.setZoneData(ZONE, zone)
    navReady = true

    // hidden ray mesh for precise nav hits
    navRayMesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ visible: false }))
    scene.add(navRayMesh)
  }

  if (cfg.hdriUrl)  await loadHDRI(cfg.hdriUrl)
  if (cfg.modelUrl) {
    try { await loadGLB(cfg.modelUrl) }
    catch (e) {
      console.warn('[GLB] Failed to load model; showing fallback cube.', e)
      const cube = new THREE.Mesh(new THREE.BoxGeometry(1,1,1),
        new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.5 }))
      cube.position.y = 1.0
      scene.add(cube)
      model = cube
    }
  }
  if (cfg.navmeshUrl) await loadNavMesh(cfg.navmeshUrl)

  // --- Teleportation / movement ---
  const raycaster = new THREE.Raycaster()
  const clock = new THREE.Clock()
  let path: THREE.Vector3[] = []
  let pathIdx = 0

  // Drag/click guard
  const down = new THREE.Vector2()
  let downTime = 0
  let dragging = false

  function planPath(to: THREE.Vector3) {
    const dest = to.clone()
    // no pathfinding available → single segment
    if (!navReady) { path = [dest]; pathIdx = 0; return }

    try {
      const start = rig.position.clone()
      // @ts-ignore inspect internal zones for robustness
      const zones = (pathfinder as any).zones || {}
      if (!zones[ZONE]) throw new Error('No zone data')

      const groupID = pathfinder.getGroup(ZONE, start)
      if (groupID == null) throw new Error('No group for start')

      const node = pathfinder.getClosestNode(dest, ZONE, groupID)
      const clamped = node ? pathfinder.clampStep(start, dest, node, ZONE, groupID) : dest
      const navPath = pathfinder.findPath(start, clamped, ZONE, groupID)

      if (navPath && navPath.length) {
        path = navPath.map(p => p.clone ? p.clone() : new THREE.Vector3(p.x, p.y, p.z))
      } else {
        path = [clamped.clone()]
      }
      pathIdx = 0
    } catch {
      path = [dest]
      pathIdx = 0
    }
  }

  function moveUserInstant(to: THREE.Vector3) {
    if (renderer.xr.isPresenting) {
      rig.position.set(to.x, 0, to.z)
    } else {
      // keep your current look; only move the body
      rig.position.set(to.x, 0, to.z)
    }
  }

  function startMove(to: THREE.Vector3, smooth: boolean) {
    const dest = to.clone()
    if (renderer.xr.isPresenting && !smooth) {
      moveUserInstant(dest) // VR instant
      return
    }
    planPath(dest)          // desktop/mobile smooth
  }

  // --- Desktop first-person look (pointer lock) ---
  function requestPointerLock() {
    if (document.pointerLockElement !== renderer.domElement) {
      renderer.domElement.requestPointerLock?.()
    }
  }
  function exitPointerLock() {
    if (document.pointerLockElement) document.exitPointerLock?.()
  }

  renderer.domElement.addEventListener('click', () => {
    // Click to lock (common UX). If already locked, click is used for teleport below.
    if (document.pointerLockElement !== renderer.domElement) {
      requestPointerLock()
    }
  })

  document.addEventListener('pointerlockchange', () => {
    // When unlocked, stop dragging state
    if (document.pointerLockElement !== renderer.domElement) dragging = false
  })

  // Mouse look when locked
  renderer.domElement.addEventListener('mousemove', (e) => {
    if (renderer.xr.isPresenting) return
    if (document.pointerLockElement === renderer.domElement) {
      dragging = true
      yaw.rotation.y -= e.movementX * LOOK_SENS_MOUSE
      pitch.rotation.x -= e.movementY * LOOK_SENS_MOUSE
      pitch.rotation.x = THREE.MathUtils.clamp(pitch.rotation.x, -LOOK_PITCH_LIMIT, LOOK_PITCH_LIMIT)
    }
  })

  // Touch: one-finger drag to look
  let lastTouchX = 0, lastTouchY = 0
  renderer.domElement.addEventListener('touchstart', (e) => {
    if (renderer.xr.isPresenting) return
    const t = e.touches[0]
    lastTouchX = t.clientX; lastTouchY = t.clientY
    down.set(t.clientX, t.clientY)
    downTime = performance.now()
    dragging = false
  }, { passive: true })

  renderer.domElement.addEventListener('touchmove', (e) => {
    if (renderer.xr.isPresenting) return
    const t = e.touches[0]
    const dx = t.clientX - lastTouchX
    const dy = t.clientY - lastTouchY
    lastTouchX = t.clientX; lastTouchY = t.clientY

    // treat as look
    yaw.rotation.y -= dx * LOOK_SENS_TOUCH
    pitch.rotation.x -= dy * LOOK_SENS_TOUCH
    pitch.rotation.x = THREE.MathUtils.clamp(pitch.rotation.x, -LOOK_PITCH_LIMIT, LOOK_PITCH_LIMIT)

    dragging = true
  }, { passive: true })

  renderer.domElement.addEventListener('touchend', (e) => {
    if (renderer.xr.isPresenting) return
    const dt = performance.now() - downTime
    const isClick = !dragging && dt <= CLICK_MS
    if (isClick && marker.visible) startMove(aimPoint, true)
    dragging = false
  })

  // Mouse click teleport (when already locked, or short click with minimal movement)
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (renderer.xr.isPresenting) return
    down.set(e.clientX, e.clientY)
    downTime = performance.now()
    dragging = false
  })
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (renderer.xr.isPresenting) return
    const dx = e.clientX - down.x
    const dy = e.clientY - down.y
    const dt = performance.now() - downTime
    const moved = (dx*dx + dy*dy) > (CLICK_PX*CLICK_PX)
    const isClick = !moved && dt <= CLICK_MS

    // If not locked yet, first click locks; second click (locked) teleports
    const locked = document.pointerLockElement === renderer.domElement
    if (!locked) {
      // first click just requests lock; ignore teleport
      requestPointerLock()
    } else if (isClick && marker.visible) {
      startMove(aimPoint, true)
    }
  })

  // --- XR controllers (ray to teleport) ---
  const tmpMat = new THREE.Matrix4()
  function addController(index: number) {
    const ctrl = renderer.xr.getController(index)
    rig.add(ctrl)

    const rayGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1)
    ])
    const rayLine = new THREE.Line(rayGeom, new THREE.LineBasicMaterial())
    rayLine.scale.z = 10
    ctrl.add(rayLine)

    ctrl.addEventListener('select', () => {
      if (marker.visible) startMove(aimPoint, false) // instant in VR
    })

    ctrl.userData.updateAim = () => {
      tmpMat.identity().extractRotation(ctrl.matrixWorld)
      raycaster.ray.origin.setFromMatrixPosition(ctrl.matrixWorld)
      raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpMat)

      let hit = navRayMesh ? raycaster.intersectObject(navRayMesh, false)[0] : undefined
      if (!hit) hit = raycaster.intersectObjects(teleportables, true)[0]

      if (hit) {
        aimPoint.copy(hit.point)
        if (hit.face && hit.object) {
          _mat3.getNormalMatrix((hit.object as THREE.Object3D).matrixWorld)
          _normal.copy(hit.face.normal).applyMatrix3(_mat3).normalize()
          _quat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _normal)
          marker.quaternion.copy(_quat)
        } else {
          _normal.set(0, 1, 0)
          marker.quaternion.set(0,0,0,1)
        }
        marker.position.copy(aimPoint).addScaledVector(_normal, 0.01)
        marker.visible = true
      } else {
        marker.visible = false
      }
    }
  }
  addController(0)
  addController(1)

  // --- XR camera parenting / unparenting ---
  renderer.xr.addEventListener('sessionstart', () => {
    // In XR: camera should be under the rig so rig translation teleports user
    if (camera.parent !== pitch) {
      // existing hierarchy is pitch -> camera; in XR, platform replaces camera pose
      // just ensure the chain exists (it does)
    }
    // zero rig rotations/scales for stability
    rig.rotation.set(0,0,0)
    rig.scale.set(1,1,1)
  })

  renderer.xr.addEventListener('sessionend', () => {
    // nothing special; desktop uses our yaw/pitch anyway
  })

  // --- Resize ---
  const onResize = () => {
    const w = mount.clientWidth, h = mount.clientHeight
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  window.addEventListener('resize', onResize)

  // --- Animate ---
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta())

    // Desktop/Mobile center‑reticle aim (ray from camera forward)
    if (!renderer.xr.isPresenting) {
      _dir.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize()
      raycaster.set(camera.getWorldPosition(_tmpV), _dir)
      let hit = navRayMesh ? raycaster.intersectObject(navRayMesh, false)[0] : undefined
      if (!hit) hit = raycaster.intersectObjects(teleportables, true)[0]

      if (hit) {
        aimPoint.copy(hit.point)
        if (hit.face && hit.object) {
          _mat3.getNormalMatrix((hit.object as THREE.Object3D).matrixWorld)
          _normal.copy(hit.face.normal).applyMatrix3(_mat3).normalize()
          _quat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _normal)
          marker.quaternion.copy(_quat)
        } else {
          _normal.set(0, 1, 0)
          marker.quaternion.set(0,0,0,1)
        }
        marker.position.copy(aimPoint).addScaledVector(_normal, 0.01)
        marker.visible = true
      } else {
        marker.visible = false
      }
    } else {
      // update XR controller aim reticle
      const c0 = renderer.xr.getController(0)
      const c1 = renderer.xr.getController(1)
      c0?.userData?.updateAim?.()
      c1?.userData?.updateAim?.()
    }

    // Smooth locomotion (desktop/mobile)
    if (path.length) {
      const target = path[pathIdx]
      const current = rig.position
      _tmpV.copy(target).sub(current)
      const dist = _tmpV.length()
      const step = MOVE_SPEED * dt
      const tol  = Math.max(0.05, step)

      if (dist <= tol) {
        rig.position.set(target.x, 0, target.z)
        pathIdx++
        if (pathIdx >= path.length) path = []
      } else {
        _tmpV.normalize().multiplyScalar(step)
        rig.position.add(_tmpV.set(_tmpV.x, 0, _tmpV.z)) // keep y=0
      }
    }

    // subtle marker pulse
    if (marker.visible) {
      const s = 1 + 0.05 * Math.sin(performance.now() * 0.006)
      marker.scale.set(s, 1, s)
    }

    renderer.render(scene, camera)
  })

  return {
    renderer, scene, camera, rig, model, mount,
    toggleBackground: () => {
      if (!envMap) return
      scene.background = scene.background ? null : envMap
    },
    resetView: () => {
      path = []
      rig.position.set(0, 0, 2.5)
      yaw.rotation.set(0, 0, 0)
      pitch.rotation.set(0, 0, 0)
    }
  }
}

export function disposeViewer(h: ViewerHandle) {
  try {
    h.renderer.setAnimationLoop(null)
    h.renderer.dispose()
    if (h.mount.contains(h.renderer.domElement)) h.mount.removeChild(h.renderer.domElement)
  } catch {}
}
