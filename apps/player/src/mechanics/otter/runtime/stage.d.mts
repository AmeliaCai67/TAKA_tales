export class Stage {
 constructor(canvas:HTMLCanvasElement,options:Record<string,unknown>);
 [key:string]:any;
 set(mode:string,scene?:string):void;
 action(kind:string,arg?:unknown):void;
 cleanup():void;
 snapshot():any;
}
