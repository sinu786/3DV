declare module 'three-pathfinding' {
  import { BufferGeometry, Vector3 } from 'three';
  export class Pathfinding {
    static createZone(geom: BufferGeometry): any;
    setZoneData(name: string, zone: any): void;
    getGroup(name: string, position: Vector3): number;
    getClosestNode(position: Vector3, name: string, groupID: number): any;
    clampStep(start: Vector3, end: Vector3, node: any, name: string, groupID: number): Vector3;
    findPath(start: Vector3, end: Vector3, name: string, groupID: number): Vector3[] | null;
  }
}
