declare module 'three/examples/jsm/controls/OrbitControls.js' {
    import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'
    export { OrbitControls }
  }
  declare module 'three/examples/jsm/webxr/VRButton.js' {
    export const VRButton: { createButton(renderer: unknown): HTMLButtonElement }
  }
  declare module 'three/examples/jsm/webxr/ARButton.js' {
    export const ARButton: { createButton(renderer: unknown, options?: any): HTMLButtonElement }
  }
  declare module 'three/examples/jsm/loaders/RGBELoader.js' {
    import { Loader, DataTexture } from 'three'
    export class RGBELoader extends Loader {
      loadAsync(url: string): Promise<DataTexture>
    }
  }
  declare module 'three/examples/jsm/loaders/GLTFLoader.js' {
    import { Loader, LoadingManager, Group } from 'three'
    export interface GLTF { scene: Group }
    export class GLTFLoader extends Loader {
      constructor(manager?: LoadingManager)
      loadAsync(url: string): Promise<GLTF>
    }
  }
  