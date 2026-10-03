import assert from 'node:assert/strict';
import test from 'node:test';
import { preparePinnedLens, resolveLensPositions, lensTargetIsCurrent, presentationDepth, clampCanvasPosition, MAX_CANVAS_EXTENT } from '../src/lib/lensWorkspace.js';
import { INITIAL_FOLLOWUP_STATE, reduceFollowupLifecycle } from '../src/lib/followupLifecycle.js';
import { buildProvenanceSnapshot, getTargetRevision } from '../src/lib/explanationProvenance.js';
const problem = { id:'problem', problem:'a+b=3', steps:[{ id:'step', math:'a+b=3' }] };
const lens = () => preparePinnedLens({ id:'lens', stepId:'step', selectedText:'a', context:{problem,solution:problem,currentStep:problem.steps[0]}, semanticIdentity:{ targetId:'a',semanticId:'a',sourceText:'a',sourceRange:{start:0,end:1} } }, problem);
test('whole-workspace revision includes every step while request evidence stays bounded', () => {
 const whole = { ...problem, steps:Array.from({length:100}, (_,i) => ({id:`step-${i}`,math:`x=${i}`})) };
 const item = { id:'workspace', semanticIdentity:{targetId:'workspace:session',semanticType:'workspace',role:'workspace',sourceText:problem.problem} };
 const before=buildProvenanceSnapshot({item,problem:whole});
 const after=buildProvenanceSnapshot({item,problem:{...whole,steps:whole.steps.map((step,i) => i===50 ? {...step,math:'x=changed'} : step)}});
 assert.notEqual(getTargetRevision(before),getTargetRevision(after));
 assert.notEqual(getTargetRevision(before),getTargetRevision(buildProvenanceSnapshot({item,problem:{...whole,finalAnswerLatex:'x=100'}})));
 assert.equal(before.evidence.steps.length,64);
 assert.equal(before.evidence.steps[0].id,'step-0');
 assert.equal(before.evidence.steps.at(-1).id,'step-99');
});
test('stable lens references parent truth and preserves provenance once created', () => {
 const a=lens(); assert.equal(a.lensId,'lens'); assert.equal(a.context.solution,undefined); assert.equal(a.context.problem,undefined);
 assert.equal(preparePinnedLens(a,problem),a); assert.equal(a.provenanceSnapshot.origin.currentStep.math,'a+b=3');
 assert.equal(lensTargetIsCurrent(a,problem),true); assert.equal(lensTargetIsCurrent(a,{...problem,steps:[{id:'step',math:'a-b=3'}]}),false);
});
test('manual canvas placement reprojects width independently of source and viewport scroll', () => {
 const a={...lens(), placementMode:'manual', x:40,y:160,xRatio:.25,positionAnchor:{stepId:'step',offsetY:50}};
 const sizes={lens:{width:320,height:180}};
 const first=resolveLensPositions([a],sizes,800,{lens:110}).lens;
 const second=resolveLensPositions([a],sizes,1000,{lens:130}).lens;
 assert.equal(first.y,160); assert.equal(second.y,160); assert.equal(first.x,126); assert.equal(second.x,176);
 assert.deepEqual(resolveLensPositions([a],sizes,800,{lens:110}).lens,first);
});
test('logical canvas allows distant notes without being bounded to solution height', () => {
 const position=clampCanvasPosition(40,5000,800,{width:320,height:300});
 assert.equal(position.y,5000);
 assert.equal(clampCanvasPosition(1e30,1e30,800,{width:320,height:300}).y,MAX_CANVAS_EXTENT-324);
 const distant=resolveLensPositions([{id:'distant',placementMode:'manual',x:40,y:5000}],{distant:{width:320,height:300}},800,{distant:100});
 assert.equal(distant.distant.y,5000);
});
test('automatic notes avoid manual note and other automatic notes, collapse keeps identity', () => {
 const notes=[{id:'manual',placementMode:'manual',x:468,y:12},{id:'auto1'},{id:'auto2',collapsed:true}];
 const sizes={manual:{width:320,height:200},auto1:{width:320,height:100},auto2:{width:320,height:48}};
 const positions=resolveLensPositions(notes,sizes,800);
 assert.equal(positions.manual.y,12); assert.equal(positions.auto1.y,224); assert.equal(positions.auto2.y,336);
});
test('legacy depth migrates to three detail levels; viewport pixels restore as automatic notes', () => {
 assert.equal(presentationDepth('professor'),'detailed'); assert.equal(presentationDepth('exam'),'concise');
 const a=preparePinnedLens({...lens(), lensId:null,placementMode:'manual',coordinateSpace:undefined,x:1000,y:40},problem);
 assert.equal(a.placementMode,'stacked'); assert.equal(a.coordinateSpace,'canvas-v1');
});
test('independent streamed threads reject cross-lens deltas and preserve partial failure', () => {
 const a={requestId:'a',conversationId:'lens-a',targetRevision:'rev-a'};
 const b={requestId:'b',conversationId:'lens-b',targetRevision:'rev-b'};
 let state=reduceFollowupLifecycle(INITIAL_FOLLOWUP_STATE,{type:'request_started',request:a,question:'why?',preservePartial:true});
 assert.equal(reduceFollowupLifecycle(state,{type:'response_delta',request:b,delta:'wrong'}),state);
 state=reduceFollowupLifecycle(state,{type:'response_delta',request:a,delta:'First'});
 assert.equal(state.status,'streaming'); state=reduceFollowupLifecycle(state,{type:'request_failed',request:a,error:'timeout',timedOut:true});
 assert.equal(state.status,'timed_out'); assert.deepEqual(state.messages.map(m=>m.text),['why?','First']); assert.equal(state.messages[1].partial,true);
 state=reduceFollowupLifecycle(state,{type:'request_started',request:b,question:'retry',preservePartial:true});
 state=reduceFollowupLifecycle(state,{type:'response_delta',request:b,delta:'Answer'});
 state=reduceFollowupLifecycle(state,{type:'request_succeeded',request:b,answer:'Answer complete'});
 assert.equal(state.status,'complete'); assert.equal(state.messages.length,4); assert.equal(state.messages[3].partial,undefined);
});
test('abort retains submitted turn and meaningful partial output and allows another turn', () => {
 const a={requestId:'a',conversationId:'a',targetRevision:'r'};
 let state=reduceFollowupLifecycle(INITIAL_FOLLOWUP_STATE,{type:'request_started',request:a,question:'derive',preservePartial:true});
 state=reduceFollowupLifecycle(state,{type:'response_delta',request:a,delta:'Given x'});
 state=reduceFollowupLifecycle(state,{type:'request_aborted',request:a});
 assert.equal(state.status,'aborted'); assert.equal(state.loading,false); assert.equal(state.messages.length,2);
 assert.equal(reduceFollowupLifecycle(state,{type:'response_delta',request:a,delta:'stale'}),state);
});
