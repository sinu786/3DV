import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'   // ⬅ no `.js`
import { VRButton } from 'three/examples/jsm/webxr/VRButton'
import { ARButton } from 'three/examples/jsm/webxr/ARButton'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'

export type ViewerConfig = {
  modelUrl?: string
  hdriUrl?: string
  showHDRIBackground?: boolean
}

export type ViewerHandle = {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
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
  renderer.xr.setReferenceSpaceType('local-floor') // floor-aware VR
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

  // Rig: move this when teleporting
  const rig = new THREE.Group()
  rig.name = 'Rig'
  rig.add(camera)
  scene.add(rig)

  // Desktop controls
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.autoRotate = false
  controls.autoRotateSpeed = 0
  controls.target.set(0, 1.2, 0)
  controls.enableDamping = true

  renderer.xr.addEventListener('sessionstart', () => { controls.enabled = false })
  renderer.xr.addEventListener('sessionend',   () => { controls.enabled = true })

  // Invisible teleport ground (raycastable, not visible / not occluding)
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x111416, transparent: true, opacity: 0 })
  groundMat.depthWrite = false
  groundMat.colorWrite = false
  groundMat.side = THREE.DoubleSide

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), groundMat)
  ground.position.y = 0
  ground.name = 'TeleportGround'
  ;(ground as any).userData.teleportable = true
  scene.add(ground)

  // Basic light (HDRI adds most of the look)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 0.4))

  const pmrem = new THREE.PMREMGenerator(renderer)
  pmrem.compileEquirectangularShader()

  const teleportables: THREE.Object3D[] = [ground]
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

    // Stop any GLB animations (turntable, etc.)
    if (gltf.animations?.length) {
      mixer = new THREE.AnimationMixer(root)
      gltf.animations.forEach((clip: THREE.AnimationClip) => {
        const action = mixer!.clipAction(clip)
        action.stop()
        action.enabled = false
      })
    }

    // SpawnPoint pivot (author an Empty named "SpawnPoint")
    const spawn = root.getObjectByName('SpawnPoint')
    if (spawn) {
      spawn.updateWorldMatrix(true, true)
      const inv = new THREE.Matrix4().copy(spawn.matrixWorld).invert()
      root.applyMatrix4(inv)
      console.log('[SpawnPoint] Found — aligned model to SpawnPoint.')
    } else {
      console.warn('[SpawnPoint] Not found — using auto center/scale.')
      const box = new THREE.Box3().setFromObject(root)
      const size = new THREE.Vector3(); box.getSize(size)
      const center = new THREE.Vector3(); box.getCenter(center)
      root.position.sub(center)
      const targetHeight = 1.5
      const scale = targetHeight / (size.y || 1.0)
      root.scale.setScalar(scale)
      root.position.y = 1.0
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

  // Load assets
  if (cfg.hdriUrl) await loadHDRI(cfg.hdriUrl)
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

  // ===== Teleportation =====
  const raycaster = new THREE.Raycaster()
  const mouse = new THREE.Vector2()
  const tmpMat = new THREE.Matrix4()

  function teleportTo(point: THREE.Vector3) {
    rig.position.set(point.x, 0, point.z)      // local-floor: keep y at 0
    controls.target.set(point.x, 1.2, point.z) // nicer desktop orbit feel
    controls.update()
  }

  // Mouse/touch teleport (desktop)
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (renderer.xr.isPresenting) return
    const rect = renderer.domElement.getBoundingClientRect()
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(mouse, camera)
    const hits = raycaster.intersectObjects(teleportables, true)
    if (hits[0]) teleportTo(hits[0].point)
  })

  // Quest controllers (right = 0, left = 1)
  function addController(index: number) {
    const ctrl = renderer.xr.getController(index)
    rig.add(ctrl)

    // Visible ray
    const rayGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1)
    ])
    const rayLine = new THREE.Line(rayGeom, new THREE.LineBasicMaterial())
    rayLine.scale.z = 10
    ctrl.add(rayLine)

    ctrl.addEventListener('select', () => {
      // World-space ray from controller
      tmpMat.identity().extractRotation(ctrl.matrixWorld)
      raycaster.ray.origin.setFromMatrixPosition(ctrl.matrixWorld)
      raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpMat)
      const hits = raycaster.intersectObjects(teleportables, true)
      if (hits[0]) teleportTo(hits[0].point)
    })
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
