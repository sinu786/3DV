// src/viewer.ts
import * as THREE from 'three'
import { VRButton } from 'three/examples/jsm/webxr/VRButton'
import { ARButton } from 'three/examples/jsm/webxr/ARButton'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import { Pathfinding } from 'three-pathfinding'

const EYE_HEIGHT = 1.6
const LOOK_SENS_MOUSE = 0.0022
const LOOK_SENS_TOUCH = 0.005
const LOOK_PITCH_LIMIT = THREE.MathUtils.degToRad(85)
const MOVE_SPEED = 2.0
const CLICK_PX = 6
const CLICK_MS = 300

const _normal = new THREE.Vector3()
const _quat   = new THREE.Quaternion()
const _mat3   = new THREE.Matrix3()
const _dir    = new THREE.Vector3()
const _tmpV   = new THREE.Vector3()

export type ViewerConfig = {
  modelUrl?: string
  hdriUrl?: string
  navmeshUrl?: string
  showHDRIBackground?: boolean
  initialModelScale?: number   // NEW (optional)
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
  setModelScale: (s: number) => void   // NEW
}

export async function initViewer(mount: HTMLElement, cfg: ViewerConfig = {}): Promise<ViewerHandle> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(mount.clientWidth, mount.clientHeight)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0
  renderer.xr.enabled = true
  renderer.xr.setReferenceSpaceType('local-floor')
  mount.appendChild(renderer.domElement)

  const vrBtn = VRButton.createButton(renderer)
  const arBtn = ARButton.createButton(renderer, { requiredFeatures: [] })
  Object.assign(vrBtn.style, { position: 'fixed', right: '12px', bottom: '12px' })
  Object.assign(arBtn.style, { position: 'fixed', right: '12px', bottom: '56px' })
  document.body.appendChild(vrBtn)
  document.body.appendChild(arBtn)

  const scene  = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(70, mount.clientWidth / mount.clientHeight, 0.01, 1000)

  // First-person rig (yaw/pitch)
  const rig = new THREE.Group(); rig.name = 'Rig'
  scene.add(rig)
  const yaw = new THREE.Object3D(); const pitch = new THREE.Object3D()
  rig.add(yaw); yaw.add(pitch); pitch.add(camera)
  yaw.position.set(0, 0, 0)
  pitch.position.set(0, EYE_HEIGHT, 0)
  rig.position.set(0, 0, 2.5)

  // All world content (model + navmesh raymesh) lives under here
  const world = new THREE.Group()
  world.name = 'World'
  scene.add(world)

  // Lights
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 0.4))

  // PMREM
  const pmrem = new THREE.PMREMGenerator(renderer)
  pmrem.compileEquirectangularShader()

  // Invisible ground fallback
  const groundMat = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0, side: THREE.DoubleSide })
  groundMat.depthWrite = false
  groundMat.colorWrite = false
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), groundMat)
  ground.name = 'TeleportGround'
  ;(ground as any).userData.teleportable = true
  scene.add(ground)

  const teleportables: THREE.Object3D[] = [ground]

  // Pathfinding
  const pathfinder = new Pathfinding()
  const ZONE = 'level'
  let modelXform = new THREE.Matrix4().identity()
  let navReady = false
  let navRayMesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material> | null = null
  let navGeomSrc: THREE.BufferGeometry | null = null   // ORIGINAL nav geometry (unscaled)
  let currentScale = cfg.initialModelScale ?? 1

  // Marker
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
    const gltf = await new GLTFLoader().loadAsync(url)
    const root = gltf.scene as THREE.Object3D
    model = root

    if (gltf.animations?.length) {
      mixer = new THREE.AnimationMixer(root)
      gltf.animations.forEach((clip: THREE.AnimationClip) => {
        const action = mixer!.clipAction(clip)
        action.stop(); action.enabled = false
      })
    }
    

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

    // put model under world
    // Apply manual transform
   // adjust this factor until right
    world.add(root)

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
  }

  async function loadNavMesh(url: string) {
    const gltf = await new GLTFLoader().loadAsync(url)

    let nm: THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]> | undefined
    gltf.scene.traverse((o: any) => {
      if (o.isMesh && (o.name === 'NavMesh' || o.userData?.navmesh)) nm = o
    })
    if (!nm) { console.warn('[NavMesh] No mesh named "NavMesh" found'); return }

    // original (unscaled) nav geometry in model space
    const base = (nm.geometry as THREE.BufferGeometry).clone()
    nm.updateWorldMatrix(true, true)
    base.applyMatrix4(nm.matrixWorld)
    base.applyMatrix4(modelXform)
    navGeomSrc = base.clone() // keep pristine copy

    // build current scaled zone & ray mesh
    rebuildNavForScale()
  }

  function rebuildNavForScale() {
    if (!navGeomSrc) return
    // remove old ray mesh
    if (navRayMesh) { world.remove(navRayMesh); navRayMesh.geometry.dispose() }

    const g = navGeomSrc.clone()
    const scaleM = new THREE.Matrix4().makeScale(currentScale, currentScale, currentScale)
    g.applyMatrix4(scaleM)

    const zone = Pathfinding.createZone(g)
    pathfinder.setZoneData(ZONE, zone)
    navReady = true

    navRayMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ visible: false }))
    world.add(navRayMesh)
  }

  if (cfg.hdriUrl)  await loadHDRI(cfg.hdriUrl)
  if (cfg.modelUrl) {
    try { await loadGLB(cfg.modelUrl) }
    catch {
      const cube = new THREE.Mesh(new THREE.BoxGeometry(1,1,1),
        new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.5 }))
      cube.position.y = 1.0
      world.add(cube)
      model = cube
    }
  }
  if (cfg.navmeshUrl) await loadNavMesh(cfg.navmeshUrl)

  // Apply initial scale (affects both model & navmesh)
  world.scale.setScalar(currentScale)
  if (navGeomSrc) rebuildNavForScale()

  // Teleport/move
  const raycaster = new THREE.Raycaster()
  const clock = new THREE.Clock()
  let path: THREE.Vector3[] = []
  let pathIdx = 0

  // Drag vs click guards
  const down = new THREE.Vector2()
  let downTime = 0
  let dragging = false

  function planPath(to: THREE.Vector3) {
    const dest = to.clone()
    if (!navReady) { path = [dest]; pathIdx = 0; return }
    try {
      const start = rig.position.clone()
      // ensure zone exists
      // @ts-ignore
      const zones = (pathfinder as any).zones || {}
      if (!zones[ZONE]) throw new Error('No zone data')

      const groupID = pathfinder.getGroup(ZONE, start)
      if (groupID == null) throw new Error('No group for start')

      const node = pathfinder.getClosestNode(dest, ZONE, groupID)
      const clamped = node ? pathfinder.clampStep(start, dest, node, ZONE, groupID) : dest
      const navPath = pathfinder.findPath(start, clamped, ZONE, groupID)

      path = (navPath && navPath.length)
        ? navPath.map(p => p.clone ? p.clone() : new THREE.Vector3(p.x, p.y, p.z))
        : [clamped.clone()]
      pathIdx = 0
    } catch {
      path = [dest]; pathIdx = 0
    }
  }

  function moveUserInstant(to: THREE.Vector3) {
    rig.position.set(to.x, 0, to.z)
  }

  function startMove(to: THREE.Vector3, smooth: boolean) {
    const dest = to.clone()
    if (renderer.xr.isPresenting && !smooth) {
      moveUserInstant(dest)
      return
    }
    planPath(dest)
  }

  // Pointer lock + look
  function requestPointerLock() {
    if (document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock?.()
  }
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== renderer.domElement) dragging = false
  })
  renderer.domElement.addEventListener('click', () => {
    if (document.pointerLockElement !== renderer.domElement) requestPointerLock()
  })
  renderer.domElement.addEventListener('mousemove', (e) => {
    if (renderer.xr.isPresenting) return
    if (document.pointerLockElement === renderer.domElement) {
      dragging = true
      yaw.rotation.y -= e.movementX * LOOK_SENS_MOUSE
      pitch.rotation.x -= e.movementY * LOOK_SENS_MOUSE
      pitch.rotation.x = THREE.MathUtils.clamp(pitch.rotation.x, -LOOK_PITCH_LIMIT, LOOK_PITCH_LIMIT)
    }
  })
  // touch look
  let lastTouchX = 0, lastTouchY = 0
  renderer.domElement.addEventListener('touchstart', (e) => {
    if (renderer.xr.isPresenting) return
    const t = e.touches[0]; lastTouchX = t.clientX; lastTouchY = t.clientY
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
    if (isClick && marker.visible) startMove(aimPoint, true)
    dragging = false
  })

  // mouse click teleport when already locked
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (renderer.xr.isPresenting) return
    down.set(e.clientX, e.clientY); downTime = performance.now(); dragging = false
  })
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (renderer.xr.isPresenting) return
    const dx = e.clientX - down.x, dy = e.clientY - down.y
    const dt = performance.now() - downTime
    const moved = (dx*dx + dy*dy) > (CLICK_PX*CLICK_PX)
    const locked = document.pointerLockElement === renderer.domElement
    if (locked && !moved && dt <= CLICK_MS && marker.visible) startMove(aimPoint, true)
    else if (!locked) requestPointerLock()
  })

  // XR controllers
  const tmpMat = new THREE.Matrix4()
  function addController(index: number) {
    const ctrl = renderer.xr.getController(index)
    rig.add(ctrl)
    const rayGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,-1)])
    const rayLine = new THREE.Line(rayGeom, new THREE.LineBasicMaterial()); rayLine.scale.z = 10
    ctrl.add(rayLine)

    ctrl.addEventListener('select', () => { if (marker.visible) startMove(aimPoint, false) })
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
          _normal.set(0, 1, 0); marker.quaternion.set(0,0,0,1)
        }
        marker.position.copy(aimPoint).addScaledVector(_normal, 0.01)
        marker.visible = true
      } else {
        marker.visible = false
      }
    }
  }
  addController(0); addController(1)

  // Resize
  window.addEventListener('resize', () => {
    const w = mount.clientWidth, h = mount.clientHeight
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix()
  })

  // Animate
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta())

    // Aim reticle from camera forward (desktop)
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
          _quat.setFromUnitVectors(new THREE.Vector3(0,1,0), _normal); marker.quaternion.copy(_quat)
        } else { marker.quaternion.set(0,0,0,1) }
        marker.position.copy(aimPoint).addScaledVector(_normal, 0.01)
        marker.visible = true
      } else { marker.visible = false }
    } else {
      const c0 = renderer.xr.getController(0), c1 = renderer.xr.getController(1)
      c0?.userData?.updateAim?.(); c1?.userData?.updateAim?.()
    }

    // Smooth move
    if (path.length) {
      const target = path[pathIdx]
      _tmpV.copy(target).sub(rig.position)
      const dist = _tmpV.length()
      const step = MOVE_SPEED * dt
      const tol  = Math.max(0.05, step)
      if (dist <= tol) {
        rig.position.set(target.x, 0, target.z)
        pathIdx++; if (pathIdx >= path.length) path = []
      } else {
        _tmpV.normalize().multiplyScalar(step)
        rig.position.add(new THREE.Vector3(_tmpV.x, 0, _tmpV.z))
      }
    }

    if (marker.visible) {
      const s = 1 + 0.05 * Math.sin(performance.now() * 0.006)
      marker.scale.set(s, 1, s)
    }

    renderer.render(scene, camera)
  })

  // Public API
  function setModelScale(s: number) {
    currentScale = Math.max(0.001, s)
    world.scale.setScalar(currentScale)
    // rebuild nav zone for accurate pathfinding at this scale
    if (navGeomSrc) rebuildNavForScale()
  }

  return {
    renderer, scene, camera, rig, model, mount,
    toggleBackground: () => {
      if (!envMap) return
      scene.background = scene.background ? null : envMap
    },
    resetView: () => {
      rig.position.set(0, 0, 2.5)
      yaw.rotation.set(0, 0, 0)
      pitch.rotation.set(0, 0, 0)
    },
    setModelScale
  }
}

export function disposeViewer(h: ViewerHandle) {
  try {
    h.renderer.setAnimationLoop(null)
    h.renderer.dispose()
    if (h.mount.contains(h.renderer.domElement)) h.mount.removeChild(h.renderer.domElement)
  } catch {}
}
