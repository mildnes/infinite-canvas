import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { CanvasNodeType } from '../app/(user)/canvas/types.ts';
import { NODE_DEFAULT_SIZE } from '../app/(user)/canvas/constants.ts';
import { fitNodeSize, nodeSizeFromRatio } from '../app/(user)/canvas/utils/canvas-node-size.ts';
import { isCanvasImageNodeType, isPanoramaNodeType, PANORAMA_NODE_SIZE } from '../app/(user)/canvas/utils/canvas-panorama.ts';
import { canvasPersistSignature } from '../app/(user)/canvas/utils/canvas-persist-signature.ts';
import { acceptsTaskUpdate, isStoppedTask } from './generation-task-run.ts';

const page=readFileSync(new URL('../app/(user)/canvas/[id]/canvas-client-page.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('page.tsx',page,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function extract(expression,globals){return vm.runInNewContext(ts.transpileModule('('+expression+')',{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,globals);}
function declaration(name,globals){return extract(ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(ast),globals);}
function fixture(task){
 const globals={ CanvasNodeType,NODE_DEFAULT_SIZE,NODE_STATUS_LOADING:'loading',NODE_STATUS_SUCCESS:'success',NODE_STATUS_ERROR:'error',
  fitNodeSize,nodeSizeFromRatio,isCanvasImageNodeType,isPanoramaNodeType,PANORAMA_NODE_SIZE,acceptsTaskUpdate,isStoppedTask,Date,
  isKIESeedreamLayerDecompositionModel:()=>false,batchCanvasImageTaskStatus:async()=>[task]};
 for(const name of ['canvasTaskCompleted','canvasTaskFailed','parseCanvasTaskTime','canvasImageTaskURLs','canvasImageTaskChildIds','applyCanvasImageTaskUpdate']) globals[name]=declaration(name,globals);
 return declaration('recoverPersistedCanvasImageTasks',globals);
}
const task={id:'original',source:'canvas',node_id:'node',source_id:'board',status:'completed',url:'/api/files/result/content',storageKey:'server:result',width:3840,height:2160,mimeType:'image/png',bytes:10422733,completed_at:'2026-10-24T20:01:00Z'};
const node=(status='error',metadata={})=>({id:'node',type:'image',width:420,height:236,position:{x:4176,y:8112},metadata:{status,content:'',imageTaskId:'original',taskPollError:true,errorDetails:'任务记录不存在，无法确认结果，请重新查询。',...metadata}});

for(const status of ['error','loading','success']) test(`actual restore recovers ${status} missing-media original run and preserves layout`,async()=>{
 const initial=node(status);const result=await fixture(task)([initial]);assert.equal(result.count,1);
 const recovered=result.nodes[0];assert.equal(recovered.metadata.content,task.url);assert.equal(recovered.metadata.status,'success');
 assert.equal(recovered.metadata.storageKey,task.storageKey);assert.equal(recovered.metadata.taskPollError,undefined);assert.equal(recovered.metadata.errorDetails,undefined);
 assert.deepEqual({width:recovered.width,height:recovered.height,position:recovered.position},{width:initial.width,height:initial.height,position:initial.position});
});
for(const [name,input] of [
 ['cancelled',node('cancelled')],['explicit failure',node('error',{taskPollError:undefined})],['existing image',node('error',{content:'keep'})],['new task',node('loading',{imageTaskId:'other'})],
]) test(`actual restore preserves ${name}`,async()=>{const result=await fixture(task)([input]);assert.equal(result.count,0);assert.equal(result.nodes[0],input);});
for(const status of ['failed','cancelled','processing']) test(`archive lookup ${status} is not treated as recovered media`,async()=>{const result=await fixture({...task,status})([node()]);assert.equal(result.count,0);});
test('restore establishes persistence baseline before repairing missing original media',()=>{
 const original={nodes:[node()],connections:[]};const repaired={...original,nodes:[{...node(),metadata:{...node().metadata,status:'success',content:task.url}}]};
 assert.notEqual(canvasPersistSignature(original),canvasPersistSignature(repaired));
 const baseline=page.indexOf('lastPersistSignatureRef.current = canvasPersistSignature(project)');
 const recovery=page.indexOf('const recovered = await recoverPersistedCanvasImageTasks');
 assert.ok(baseline>0&&baseline<recovery,'recovered media must not be swallowed as an unsaved initial signature');
});
