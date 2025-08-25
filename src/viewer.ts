import * as THREE from 'three'
import { OrbitControls as OrbitControlsImpl } from 'three/examples/jsm/controls/OrbitControls'
import { VRButton } from 'three/examples/jsm/webxr/VRButton'
import { ARButton } from 'three/examples/jsm/webxr/ARButton'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import { Pathfinding } from 'three-pathfinding'

// derive the instance type from the class
type Controls = InstanceType<typeof OrbitControlsImpl>

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
  controls: Controls
  model?: THREE.Object3D
  toggleBackground: () => void
  resetCamera: () => void
  mount: HTMLElement
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

  // XR Buttons
  const vrBtn = VRButton.createButton(renderer)
  const arBtn = ARButton.createButton(renderer, { requiredFeatures: [] })
  Object.assign(vrBtn.style, { position: 'fixed', right: '12px', bottom: '12px' })
  Object.assign(arBtn.style, { position: 'fixed', right: '12px', bottom: '56px' })
  document.body.appendChild(vrBtn)
  document.body.appendChild(arBtn)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(70, mount.clientWidth / mount.clientHeight, 0.01, 1000)

  // Rig (we move this when teleporting)
  const rig = new THREE.Group()
  rig.name = 'Rig'
  rig.add(camera)
  scene.add(rig)

  // Desktop controls
  const controls: Controls = new OrbitControlsImpl(camera, renderer.domElement)
  controls.autoRotate = false
  controls.autoRotateSpeed = 0
  controls.target.set(0, 1.2, 0)
  controls.enableDamping = true

  renderer.xr.addEventListener('sessionstart', () => { controls.enabled = false })
  renderer.xr.addEventListener('sessionend',   () => { controls.enabled = true })

  // Invisible teleport ground: raycastable, non-visual, non-occluding
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x111416, transparent: true, opacity: 0 })
  groundMat.depthWrite = false
  groundMat.colorWrite = false
  groundMat.side = THREE.DoubleSide

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), groundMat)
  ground.position.y = 0
  ground.name = 'TeleportGround'
  ;(ground as any).userData.teleportable = true
  scene.add(ground)

  // Light (HDRI will provide most of the look)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 0.4))

  // HDRI prefilter
  const pmrem = new THREE.PMREMGenerator(renderer)
  pmrem.compileEquirectangularShader()

  // Teleport targets
  const teleportables: THREE.Object3D[] = [ground]

  // Navmesh & targeting
  const pathfinder = new Pathfinding()
  const ZONE = 'level'
  let modelXform = new THREE.Matrix4().identity()
  let navReady = false
  let navRayMesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material> | null = null

  const aimPoint = new THREE.Vector3()
  const marker = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.22, 0.02, 28, 1, true),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35 })
  )
  marker.rotation.x = -Math.PI / 2
  ;(marker.material as THREE.MeshBasicMaterial).depthTest = false
  marker.renderOrder = 999
  marker.visible = false
  scene.add(marker)

  // Smooth locomotion (desktop/mobile)
  let path: THREE.Vector3[] = []
  let pathIdx = 0
  const MOVE_SPEED = 2.0 // m/s

  const clock = new THREE.Clock()

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

  async function loadNavMesh(url: string) {
    const gltf = await new GLTFLoader().loadAsync(url)

    let nm: THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]> | undefined
    gltf.scene.traverse((o: any) => {
      if (o.isMesh && (o.name === 'NavMesh' || o.userData?.navmesh)) {
        nm = o as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>
      }
    })
    if (!nm) { console.warn('[NavMesh] No mesh named "NavMesh" found'); return }

    // Bake world transform into cloned geometry
    const geom = (nm.geometry as THREE.BufferGeometry).clone()
    nm.updateWorldMatrix(true, true)
    geom.applyMatrix4(nm.matrixWorld)

    geom.applyMatrix4(modelXform) // navmesh needs same model xform as the scene
    navRayMesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true, opacity: 1, transparent: true }))
    scene.add(navRayMesh)
    
    // Pathfinding zone
    const zone = Pathfinding.createZone(geom)
    pathfinder.setZoneData(ZONE, zone)
    navReady = true

    // Hidden mesh to raycast *exactly* on navmesh
    navRayMesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ visible: false }))
    scene.add(navRayMesh)

    console.log('[NavMesh] Zone ready + raycaster mesh')
  }

  async function loadGLB(url: string) {
    const hasExternalNav = !!cfg.navmeshUrl

    const loader = new GLTFLoader()
    const gltf = await loader.loadAsync(url)

    const root = gltf.scene as THREE.Object3D
    model = root

    // Stop any GLB animations (e.g., turntable)
    if (gltf.animations?.length) {
      mixer = new THREE.AnimationMixer(root)
      gltf.animations.forEach((clip: THREE.AnimationClip) => {
        const action = mixer!.clipAction(clip)
        action.stop()
        action.enabled = false
      })
    }

    // SpawnPoint pivot (Empty named "SpawnPoint")
   // SpawnPoint pivot (Empty named "SpawnPoint")
const spawn = root.getObjectByName('SpawnPoint')
if (spawn) {
  spawn.updateWorldMatrix(true, true)
  const inv = new THREE.Matrix4().copy(spawn.matrixWorld).invert()
  root.applyMatrix4(inv)
  modelXform.copy(inv) // ⬅ record exactly what we applied to the model
  console.log('[SpawnPoint] Found — aligned model to SpawnPoint.')
} else {
  console.warn('[SpawnPoint] Not found — using auto center/scale.')
  // Compose a single transform: T(-center) → S(scale) → T(0, +1, 0)
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
      // Optional: allow GLB floor meshes as teleport targets
      if (o.isMesh && (o.name?.toLowerCase?.().includes('floor') || o.userData?.teleportable)) {
        teleportables.push(o)
      }
    })

    scene.add(root)
  }

  // Load assets
  if (cfg.hdriUrl) await loadHDRI(cfg.hdriUrl)
  if (cfg.navmeshUrl) await loadNavMesh(cfg.navmeshUrl)
  if (cfg.modelUrl) {
    try { await loadGLB(cfg.modelUrl) }
    catch (e) {
      console.warn('[GLB] Failed to load model; showing fallback cube.', e)
      const cube = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.5 }))
      cube.position.y = 1.0
      scene.add(cube)
      model = cube
    }
  }

  // ===== Teleportation & movement =====
  const raycaster = new THREE.Raycaster()
  const mouse = new THREE.Vector2()
  const tmpMat = new THREE.Matrix4()

  // click threshold (no move on drags)
  const down = new THREE.Vector2()
  let downTime = 0
  const CLICK_PX = 6
  const CLICK_MS = 300

  function planPath(to: THREE.Vector3) {
    if (!navReady) { path = [to]; pathIdx = 0; return }
    const start = rig.position.clone()
    const groupID = pathfinder.getGroup(ZONE, start)
    const navPath = pathfinder.findPath(start, to, ZONE, groupID)
    path = navPath && navPath.length ? navPath : [to]
    pathIdx = 0
  }

  function startMove(to: THREE.Vector3, smooth: boolean) {
    if (renderer.xr.isPresenting && !smooth) {
      // VR: instant teleport (comfort)
      rig.position.set(to.x, 0, to.z)
      controls.target.set(to.x, 1.2, to.z)
      controls.update()
      return
    }
    // Desktop/mobile: plan path and let the loop lerp (preserves navmesh Y)
    planPath(to)
  }

  // Desktop aim marker — prefer the navmesh ray
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (renderer.xr.isPresenting) return
    const rect = renderer.domElement.getBoundingClientRect()
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1

    raycaster.setFromCamera(mouse, camera)
    let hit: THREE.Intersection | undefined

    if (navRayMesh) hit = raycaster.intersectObject(navRayMesh, false)[0]
    else            hit = raycaster.intersectObjects(teleportables, true)[0]

    if (hit) {
      aimPoint.copy(hit.point)
      marker.position.set(aimPoint.x, 0.01, aimPoint.z)
      marker.visible = true
    } else {
      marker.visible = false
    }
  })

  // Use click threshold (no move on drags)
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (renderer.xr.isPresenting) return
    down.set(e.clientX, e.clientY)
    downTime = performance.now()
  })
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (renderer.xr.isPresenting) return
    const dx = e.clientX - down.x
    const dy = e.clientY - down.y
    const dt = performance.now() - downTime
    const isClick = (dx*dx + dy*dy) <= (CLICK_PX*CLICK_PX) && dt <= CLICK_MS
    if (isClick && marker.visible) startMove(aimPoint, true)
  })

  // XR controllers
  function addController(index: number) {
    const ctrl = renderer.xr.getController(index)
    rig.add(ctrl)

    // Visible ray from controller
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

    // Update marker each frame from controller aim — prefer navmesh ray
    ctrl.userData.updateAim = () => {
      tmpMat.identity().extractRotation(ctrl.matrixWorld)
      raycaster.ray.origin.setFromMatrixPosition(ctrl.matrixWorld)
      raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpMat)
      let hit: THREE.Intersection | undefined
      if (navRayMesh) hit = raycaster.intersectObject(navRayMesh, false)[0]
      else            hit = raycaster.intersectObjects(teleportables, true)[0]
      if (hit) {
        aimPoint.copy(hit.point)
        marker.position.set(aimPoint.x, 0.01, aimPoint.z)
        marker.visible = true
      } else {
        marker.visible = false
      }
    }
  }
  addController(0)
  addController(1)

  // ===== Animate =====
  const onResize = () => {
    const w = mount.clientWidth, h = mount.clientHeight
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  window.addEventListener('resize', onResize)

  renderer.setAnimationLoop(() => {
    // Smooth locomotion (desktop/mobile)
    if (path.length) {
      const dt = Math.min(0.05, clock.getDelta())
      const target = path[pathIdx]
      const toTarget = target.clone().sub(rig.position)
      const dist = toTarget.length()
      const step = MOVE_SPEED * dt

      if (dist <= Math.max(0.02, step)) {
        rig.position.copy(target) // snap to waypoint (includes navmesh Y)
        pathIdx++
        if (pathIdx >= path.length) path = []
      } else {
        toTarget.normalize().multiplyScalar(step)
        rig.position.add(toTarget)
      }
      controls.target.set(rig.position.x, 1.2, rig.position.z)
      controls.update()
    }

    // Update controller aim marker in XR
    if (renderer.xr.isPresenting) {
      const c0 = renderer.xr.getController(0)
      const c1 = renderer.xr.getController(1)
      c0?.userData?.updateAim?.()
      c1?.userData?.updateAim?.()
    }

    // Subtle marker pulse
    if (marker.visible) {
      const s = 1 + 0.05 * Math.sin(performance.now() * 0.006)
      marker.scale.set(s, 1, s)
    }

    if (!renderer.xr.isPresenting) controls.update()
    renderer.render(scene, camera)
  })

  return {
    renderer, scene, camera, controls, model, mount,
    toggleBackground: () => {
      if (!envMap) return
      scene.background = scene.background ? null : envMap
    },
    resetCamera: () => {
      rig.position.set(0, 0, 0)
      camera.position.set(0, 1.6, 2.5)
      controls.target.set(0, 1.2, 0)
      controls.update()
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
