// Independent benchmark oracle: dense rational coefficient vectors, not the
// verifier parser, AST, differentiator, domain engine or normalization routines.
// No floating-point calculation decides a polynomial ground-truth label.
import assert from 'node:assert/strict';
export function q(n,d=1n) {
  n=BigInt(n); d=BigInt(d); assert.notEqual(d,0n);
  let a=n<0n?-n:n,b=d<0n?-d:d; while(b) [a,b]=[b,a%b];
  return [n*(d<0n?-1n:1n)/a,(d<0n?-d:d)/a];
}
export const add=(a,b)=>q(a[0]*b[1]+b[0]*a[1],a[1]*b[1]);
export const mul=(a,b)=>q(a[0]*b[0],a[1]*b[1]);
export const neg=a=>[-a[0],a[1]];
export const textQ=a=>a[1]===1n?String(a[0]):`${a[0]}/${a[1]}`;
export const vector=a=>a.map(n=>Array.isArray(n)?n:q(n));
const trim=a=>{ while(a.length>1 && !a.at(-1)[0]) a.pop(); return a; };
export const plus=(a,b)=>trim(Array.from({length:Math.max(a.length,b.length)},(_,i)=>add(a[i]||q(0),b[i]||q(0))));
export const scale=(a,k)=>trim(a.map(c=>mul(c,k)));
export function times(a,b) {
  const out=Array.from({length:a.length+b.length-1},()=>q(0));
  for(let i=0;i<a.length;i++) for(let j=0;j<b.length;j++) out[i+j]=add(out[i+j],mul(a[i],b[j]));
  return trim(out);
}
export const derivative=a=>a.length===1?[q(0)]:a.slice(1).map((c,i)=>mul(c,q(i+1)));
export const primitive=a=>[q(0),...a.map((c,i)=>mul(c,q(1,i+1)))];
export const evaluate=(a,x)=>a.reduceRight((sum,c)=>add(mul(sum,x),c),q(0));
export const integral=(a,l,u)=>add(evaluate(primitive(a),u),neg(evaluate(primitive(a),l)));
export const equal=(a,b)=>plus(a,scale(b,q(-1))).every(c=>c[0]===0n);
export const expression=a=>a.map((c,i)=>`(${textQ(c)})${i?`*x^${i}`:''}`).join('+');
export function certificate(expected,actual) {
  const difference=plus(expected,scale(actual,q(-1)));
  return {engine:'independent-dense-rational-polynomial-v1', expectedCoefficients:expected.map(textQ),actualCoefficients:actual.map(textQ),differenceCoefficients:difference.map(textQ),status:equal(expected,actual)?'mathematically_correct':'mathematically_incorrect'};
}
// Restricted parser used ONLY to validate oracle-generated strings and simple
// source polynomials; reject every token outside this independent grammar.
export function parsePolynomial(source) {
  const tokens=source.match(/\d+(?:\.\d+)?|x|[()+*/^-]/g)||[];
  assert.equal(tokens.join(''),source.replaceAll(/\s/g,''),'oracle unsupported syntax');
  let i=0;
  const take=t=>{assert.equal(tokens[i++],t);};
  const atom=()=>{const t=tokens[i++]; if(t==='('){const a=sum();take(')');return a;} if(t==='x')return vector([0,1]); assert.match(t||'',/^\d+(\.\d+)?$/);const [a,b='']=t.split('.');return [q(BigInt(a+b),10n**BigInt(b.length))];};
  const unary=()=>{if(tokens[i]==='-'){i++;return scale(unary(),q(-1));}if(tokens[i]==='+'){i++;return unary();}let a=atom();if(tokens[i]==='^'){i++;const b=unary();assert.equal(b.length,1);assert.equal(b[0][1],1n);assert.ok(b[0][0]>=0n && b[0][0]<=24n);let p=vector([1]);for(let j=0n;j<b[0][0];j++)p=times(p,a);a=p;}return a;};
  const product=()=>{let a=unary();while(['*','/'].includes(tokens[i])){const op=tokens[i++],b=unary();if(op==='*')a=times(a,b);else{assert.equal(b.length,1);a=scale(a,q(b[0][1],b[0][0]));}}return a;};
  const sum=()=>{let a=product();while(['+','-'].includes(tokens[i])){const op=tokens[i++],b=product();a=plus(a,op==='-'?scale(b,q(-1)):b);}return a;};
  const a=sum();assert.equal(i,tokens.length);return a;
}
