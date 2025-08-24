
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js'
import { ARButton } from 'three/examples/jsm/webxr/ARButton.js'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

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
  renderer.xr.setReferenceSpaceType('local') // 'local' also available
  mount.appendChild(renderer.domElement)

  // XR Buttons
  const vrBtn = VRButton.createButton(renderer)
  const arBtn = ARButton.createButton(renderer, { requiredFeatures: [] })
  vrBtn.style.position = 'fixed'
  vrBtn.style.right = '12px'
  vrBtn.style.bottom = '12px'
  arBtn.style.position = 'fixed'
  arBtn.style.right = '12px'
  arBtn.style.bottom = '56px'
  document.body.appendChild(vrBtn)
  document.body.appendChild(arBtn)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(70, mount.clientWidth / mount.clientHeight, 0.01, 1000)
  camera.position.set(0, 1.6, 2.5)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.autoRotate = false
  controls.autoRotateSpeed = 0.0
  controls.target.set(0, 1.2, 0)
  controls.enableDamping = true

  renderer.xr.addEventListener('sessionstart', () => { controls.enabled = false })
  renderer.xr.addEventListener('sessionend',   () => { controls.enabled = true })

  // Floor
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(6, 64).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x1c2430, metalness: 0.0, roughness: 0.9 })
  )
  floor.position.y = 0
  scene.add(floor)

  // Lighting (ambient add for non-HDR case)
  const hemi = new THREE.HemisphereLight(0xffffff, 0x404040, 0.4)
  scene.add(hemi)

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
    } catch (e) {
      console.warn('[HDRI] Failed to load, continuing without environment.', e)
    }
  }

  let model: THREE.Object3D | undefined
  let mixer: THREE.AnimationMixer | undefined
  let initialQuat: THREE.Quaternion | null = null
  let initialPos: THREE.Vector3 | null = null
  
  async function loadGLB(url: string) {
    const loader = new GLTFLoader()
    const gltf = await loader.loadAsync(url)
    model = gltf.scene
  
    // 🔹 Stop clips if the GLB has a “turntable” animation baked in
    if (gltf.animations && gltf.animations.length) {
      mixer = new THREE.AnimationMixer(model)
      gltf.animations.forEach((clip) => {
        const action = mixer!.clipAction(clip)
        action.stop()
        action.enabled = false
      })
    }
  
    // SpawnPoint logic (unchanged)
    const spawn = model.getObjectByName('SpawnPoint')
    if (spawn) {
      spawn.updateWorldMatrix(true, true)
      const inv = new THREE.Matrix4().copy(spawn.matrixWorld).invert()
      model.applyMatrix4(inv)
      console.log('[SpawnPoint] Found — aligned model to SpawnPoint.')
    } else {
      console.warn('[SpawnPoint] Not found — using auto center/scale.')
      const box = new THREE.Box3().setFromObject(model)
      const size = new THREE.Vector3(); box.getSize(size)
      const center = new THREE.Vector3(); box.getCenter(center)
      model.position.sub(center)
      const targetHeight = 1.5
      const scale = targetHeight / (size.y || 1.0)
      model.scale.setScalar(scale)
      model.position.y = 1.0
    }
  
    model.traverse((o: any) => {
      if (o.isMesh) {
        o.castShadow = true
        o.receiveShadow = true
        if (o.material) o.material.envMapIntensity = 1.0
      }
    })
  
    scene.add(model)
  
    // 🔹 Capture initial transform for hard lock
    initialQuat = model.quaternion.clone()
    initialPos  = model.position.clone()
  }
  
  
  

  if (cfg.hdriUrl) await loadHDRI(cfg.hdriUrl)
  if (cfg.modelUrl) {
    try {
      await loadGLB(cfg.modelUrl)
    } catch (e) {
      console.warn('[GLB] Failed to load model; showing fallback cube.', e)
      const cube = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.5 }))
      cube.position.y = 1.0
      scene.add(cube)
      model = cube
    }
  } else {
    const cube = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.5 }))
    cube.position.y = 1.0
    scene.add(cube)
    model = cube
  }

  // Animate
  const clock = new THREE.Clock()
  const onResize = () => {
    const w = mount.clientWidth, h = mount.clientHeight
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  window.addEventListener('resize', onResize)

  const loop = () => {
    const t = clock.getElapsedTime()
   // if (model) model.rotation.y = t * 0.1
    if (!renderer.xr.isPresenting) controls.update()
    renderer.render(scene, camera)
  }
  renderer.setAnimationLoop(loop)

  return {
    renderer, scene, camera, controls, model, mount,
    toggleBackground: () => {
      if (!envMap) return
      if (scene.background) scene.background = null
      else scene.background = envMap
    },
    resetCamera: () => {
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
