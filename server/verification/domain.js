import { binary, exactValue, format, num, parseExpression, substitute, variables } from "./expression.js";

// Assumptions are supplied by the caller, never inferred from provider confidence
// or accepted from a provider's assertion that its own answer is correct.
export function assumptionContext(assumptions = []) {
  const supported = []; const unsupported = [];
  if (!Array.isArray(assumptions) || assumptions.length > 32) return { supported, unsupported: ["assumption_shape_or_resource_limit"], inconsistent: false };
  for (const entry of Array.isArray(assumptions) ? assumptions.slice(0, 32) : []) {
    try {
      if (!entry || !/^[A-Za-z]$/u.test(entry.variable) || ![">", ">=", "<", "<=", "!=", "="].includes(entry.relation)) throw new Error();
      const ast = parseExpression(String(entry.value)); const value = exactValue(ast);
      if (!value) throw new Error();
      supported.push({ ...entry, value: String(entry.value), exact: value, ast });
    } catch { unsupported.push(entry); }
  }
  // Empty or inconsistent intersections cannot justify a vacuous proof.
  let inconsistent = false;
  for (const name of new Set(supported.map((a) => a.variable))) {
    const items = supported.filter((a) => a.variable === name);
    const compare = (a, b) => a.n * b.d - b.n * a.d;
    const lowers = items.filter((a) => [">", ">=", "="].includes(a.relation));
    const uppers = items.filter((a) => ["<", "<=", "="].includes(a.relation));
    for (const l of lowers) for (const u of uppers) {
      const c = compare(l.exact, u.exact);
      if (c > 0n || (c === 0n && (l.relation === ">" || u.relation === "<"))) inconsistent = true;
      if (c === 0n && items.some((a) => a.relation === "!=" && compare(a.exact, l.exact) === 0n)) inconsistent = true;
    }
  }
  return { supported, unsupported, inconsistent };
}

const allSigns = () => new Set([-1, 0, 1]);
function signs(ast, context) {
  const exact = exactValue(ast);
  if (exact) return new Set([exact.n < 0n ? -1 : exact.n > 0n ? 1 : 0]);
  if (ast.type === "constant") return new Set([1]);
  if (ast.type === "variable") {
    let result = allSigns();
    for (const a of context.supported.filter((a) => a.variable === ast.name)) {
      let allowed = allSigns(); const n = a.exact.n;
      if (a.relation === "=") allowed = new Set([n < 0n ? -1 : n > 0n ? 1 : 0]);
      if (a.relation === ">" && n >= 0n || a.relation === ">=" && n > 0n) allowed = new Set([1]);
      if (a.relation === ">=" && n === 0n) allowed = new Set([0, 1]);
      if (a.relation === "<" && n <= 0n || a.relation === "<=" && n < 0n) allowed = new Set([-1]);
      if (a.relation === "<=" && n === 0n) allowed = new Set([-1, 0]);
      if (a.relation === "!=" && n === 0n) allowed = new Set([-1, 1]);
      result = new Set([...result].filter((v) => allowed.has(v)));
    }
    return result;
  }
  if (ast.type === "call") {
    if (ast.name === "exp") return new Set([1]);
    if (["sqrt", "abs"].includes(ast.name)) return new Set([0, 1]);
    return allSigns();
  }
  const a = signs(ast.left, context); const b = signs(ast.right, context);
  if (ast.op === "^") {
    const exponent = exactValue(ast.right);
    if (exponent?.d === 1n && exponent.n % 2n === 0n) return new Set(a.has(0) ? [0, 1] : [1]);
    return a;
  }
  const out = new Set();
  for (const x of a) for (let y of b) {
    if (["*", "/"].includes(ast.op)) out.add(x * y);
    else {
      if (ast.op === "-") y = -y;
      if (!x) out.add(y); else if (!y || x === y) out.add(x); else for (const s of allSigns()) out.add(s);
    }
  }
  return out;
}

export function domainObligations(asts, context) {
  const obligations = [];
  const add = (ast, requirement, resolved) => obligations.push({ expression: format(ast), requirement, resolved });
  const requireSign = (ast, requirement, allowed) => {
    const found = signs(ast, context);
    add(ast, requirement, found.size > 0 && [...found].every((s) => allowed.includes(s)));
  };
  function visit(ast) {
    if (ast.type === "binary") {
      visit(ast.left); visit(ast.right);
      if (ast.op === "/") requireSign(ast.right, "nonzero", [-1, 1]);
      if (ast.op === "^") {
        const n = exactValue(ast.right);
        if (n?.d === 1n) { if (n.n <= 0n) requireSign(ast.left, "nonzero_for_nonpositive_power", [-1, 1]); }
        else requireSign(ast.left, "positive_real_power_base", [1]);
      }
    } else if (ast.type === "call") {
      visit(ast.argument);
      if (ast.name === "ln") requireSign(ast.argument, "positive_log_argument", [1]);
      if (ast.name === "sqrt") requireSign(ast.argument, "nonnegative_square_root_argument", [0, 1]);
      if (ast.name === "tan") add(ast.argument, "cos_argument_nonzero", false);
      if (["asin", "acos"].includes(ast.name)) {
        requireSign(binary("+", ast.argument, num(1)), "inverse_argument_at_least_minus_one", [0, 1]);
        requireSign(binary("-", num(1), ast.argument), "inverse_argument_at_most_one", [0, 1]);
      }
    }
  }
  asts.forEach(visit);
  return [...new Map(obligations.map((o) => [JSON.stringify(o), o])).values()];
}

export function sampleAllowed(values, context) {
  return context.supported.every((a) => {
    if (!(a.variable in values)) return true;
    try {
      const x = exactValue(parseExpression(String(values[a.variable])));
      const delta = x.n * a.exact.d - a.exact.n * x.d;
      return { ">": delta > 0n, ">=": delta >= 0n, "<": delta < 0n, "<=": delta <= 0n, "!=": delta !== 0n, "=": delta === 0n }[a.relation];
    } catch { return false; }
  });
}

// Forward error estimates and exclusion margins, not rigorous interval proofs.
// All original operands are evaluated, so zero multiplication cannot hide a pole.
export function evaluate(ast, values = {}) {
  const eps = Number.EPSILON;
  const checked = (v, e = 0) => {
    if (!Number.isFinite(v) || !Number.isFinite(e) || Math.abs(v) > 1e100) throw new Error("nonfinite_or_unstable");
    return { v, e: e + Math.abs(v) * eps * 8 };
  };
  if (ast.type === "number") return checked(Number(ast.value.n) / Number(ast.value.d));
  if (ast.type === "constant") return checked(ast.name === "pi" ? Math.PI : Math.E);
  if (ast.type === "variable") return checked(values[ast.name]);
  if (ast.type === "binary") {
    const a = evaluate(ast.left, values); const b = evaluate(ast.right, values);
    if (ast.op === "+") return checked(a.v + b.v, a.e + b.e);
    if (ast.op === "-") return checked(a.v - b.v, a.e + b.e);
    if (ast.op === "*") return checked(a.v * b.v, Math.abs(a.v) * b.e + Math.abs(b.v) * a.e + a.e * b.e);
    if (ast.op === "/") {
      if (Math.abs(b.v) <= Math.max(1e-10, b.e * 64)) throw new Error("near_singularity");
      return checked(a.v / b.v, (a.e + Math.abs(a.v / b.v) * b.e) / (Math.abs(b.v) - b.e));
    }
    const exponent = exactValue(ast.right);
    if ((a.v <= 0 && exponent?.d !== 1n) || (a.v === 0 && b.v <= 0) || Math.abs(b.v) > 100) throw new Error("power_domain_or_stability");
    const v = a.v ** b.v;
    const err = Math.abs(b.v * a.v ** (b.v - 1)) * a.e + (a.v > 0 ? Math.abs(v * Math.log(a.v)) * b.e : 0);
    return checked(v, Number.isNaN(err) && a.v === 0 && b.v > 0 ? 0 : err);
  }
  const a = evaluate(ast.argument, values); const x = a.v;
  if (["sin", "cos", "tan"].includes(ast.name) && Math.abs(x) > 1e6) throw new Error("large_trig_argument");
  if (ast.name === "ln" && x <= Math.max(1e-10, a.e * 64)) throw new Error("log_domain_or_boundary");
  if (ast.name === "sqrt" && x < 0) throw new Error("square_root_domain");
  if (ast.name === "sqrt" && x <= a.e * 64 && exactValue(ast.argument)?.n !== 0n) throw new Error("square_root_boundary_or_roundoff");
  if (["asin", "acos"].includes(ast.name) && Math.abs(x) >= 1 - Math.max(1e-10, a.e * 64)) throw new Error("inverse_domain_or_boundary");
  if (ast.name === "tan" && Math.abs(Math.cos(x)) < 1e-8) throw new Error("near_tangent_pole");
  const functions = { sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp, ln: Math.log, sqrt: Math.sqrt, abs: Math.abs, asin: Math.asin, acos: Math.acos, atan: Math.atan };
  const slopes = { sin: 1, cos: 1, tan: 1 / Math.cos(x) ** 2, exp: Math.exp(x), ln: 1 / x, sqrt: x === 0 ? 0 : 1 / (2 * Math.sqrt(x)), abs: 1, asin: 1 / Math.sqrt(1 - x * x), acos: 1 / Math.sqrt(1 - x * x), atan: 1 };
  return checked(functions[ast.name](x), Math.abs(slopes[ast.name]) * a.e + eps * 32);
}

export function substituteAll(ast, bindings) {
  for (const [name, value] of Object.entries(bindings)) ast = substitute(ast, name, value);
  return ast;
}

// Restrict quadrature to globally continuous expressions without domain-sensitive
// operations. Endpoint evaluation alone cannot exclude hidden interior poles.
export function quadratureSafe(ast, variable) {
  if ([...variables(ast)].some((v) => v !== variable)) return false;
  if (ast.type === "binary") {
    if (ast.op === "/") { const q = exactValue(ast.right); if (!q?.n) return false; }
    if (ast.op === "^") { const q = exactValue(ast.right); if (!q || q.d !== 1n || q.n < 1n || q.n > 12n) return false; }
    return quadratureSafe(ast.left, variable) && quadratureSafe(ast.right, variable);
  }
  if (ast.type === "call") return ["sin", "cos", "exp", "atan", "abs"].includes(ast.name) && quadratureSafe(ast.argument, variable);
  return true;
}
