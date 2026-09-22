// A bounded scalar-real grammar. This parser never repairs mathematical text,
// executes input, expands TeX macros, or consumes only a convenient substring.
export const LIMITS = Object.freeze({ chars: 2400, tokens: 400, depth: 40, terms: 128, operations: 12000, power: 12 });
export function unsupported(message) { throw new Error(message); }

export function rational(n, d = 1n) {
  if (!d) unsupported("zero_denominator");
  if (n.toString().length > 300 || d.toString().length > 300) unsupported("rational_resource_limit");
  let a = n < 0n ? -n : n;
  let b = d < 0n ? -d : d;
  while (b) [a, b] = [b, a % b];
  const sign = d < 0n ? -1n : 1n;
  return { n: sign * n / a, d: sign * d / a };
}
export function decimal(text) {
  if (!/^\d+(?:\.\d*)?$|^\.\d+$/u.test(text) || text.length > 80) unsupported("unsupported_number");
  const [whole, fraction = ""] = text.split(".");
  return rational(BigInt((whole || "0") + fraction), 10n ** BigInt(fraction.length));
}
export const addQ = (a, b) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
export const mulQ = (a, b) => rational(a.n * b.n, a.d * b.d);
export const negQ = (a) => rational(-a.n, a.d);
export const divQ = (a, b) => rational(a.n * b.d, a.d * b.n);
export const qText = (q) => q.d === 1n ? String(q.n) : `${q.n}/${q.d}`;
export const num = (n) => ({ type: "number", value: typeof n === "object" ? n : rational(BigInt(n)) });
export const binary = (op, left, right) => ({ type: "binary", op, left, right });
export const call = (name, argument) => ({ type: "call", name, argument });
const FUNCTIONS = new Set(["sin", "cos", "tan", "exp", "ln", "sqrt", "abs", "asin", "acos", "atan", "arcsin", "arccos", "arctan"]);

function tokenize(source) {
  if (typeof source !== "string" || !source.trim() || source.length > LIMITS.chars) unsupported("expression_size_or_empty");
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (/\s/u.test(char)) { i++; continue; }
    if (char === "\\") {
      const match = source.slice(i).match(/^\\([A-Za-z]+|[,;! :])/u);
      if (!match) unsupported("unsupported_tex_command");
      i += match[0].length;
      const name = match[1];
      if ([",", ";", "!", " ", ":", "left", "right"].includes(name)) continue;
      if (["cdot", "times"].includes(name)) tokens.push("*");
      else if (["frac", "dfrac", "tfrac"].includes(name)) tokens.push("frac");
      else if (FUNCTIONS.has(name) || ["pi", "int", "boxed"].includes(name)) tokens.push(name);
      else unsupported(`unsupported_tex_command:${name}`);
    } else if (/[0-9.]/u.test(char)) {
      const match = source.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)/u);
      if (!match) unsupported("unsupported_number");
      tokens.push({ number: match[0] }); i += match[0].length;
    } else if (/[A-Za-z]/u.test(char)) {
      const word = source.slice(i).match(/^[A-Za-z]+/u)[0];
      if (word.length !== 1 && !FUNCTIONS.has(word) && !["pi", "dx", "dy", "dz", "dt", "du", "dv", "dw"].includes(word)) unsupported("ambiguous_identifier_or_prose");
      tokens.push(word); i += word.length;
    } else if ("+-*/^(){}=_'".includes(char)) { tokens.push(char); i++; }
    else if ({ "−": "-", "π": "pi", "∫": "int", "·": "*", "×": "*" }[char]) {
      tokens.push({ "−": "-", "π": "pi", "∫": "int", "·": "*", "×": "*" }[char]); i++;
    } else unsupported("unsupported_notation");
    if (tokens.length > LIMITS.tokens) unsupported("token_resource_limit");
  }
  return tokens;
}

function parser(source, { texScripts = false } = {}) {
  const tokens = tokenize(source);
  let i = 0;
  let depth = 0;
  const peek = () => tokens[i];
  const take = (expected = undefined) => {
    const token = tokens[i++];
    if (token === undefined || (expected !== undefined && token !== expected)) unsupported("unexpected_token");
    return token;
  };
  const isSymbol = (t) => typeof t === "string" && /^[A-Za-z]$/u.test(t);
  function group() {
    const open = take();
    if (!["(", "{"].includes(open)) unsupported("explicit_group_required");
    const node = expression(); take(open === "(" ? ")" : "}"); return node;
  }
  function primary() {
    const t = peek();
    if (t?.number) { take(); return num(decimal(t.number)); }
    if (["(", "{"].includes(t)) return group();
    if (t === "frac") { take(); return binary("/", group(), group()); }
    if (t === "boxed") { take(); return group(); }
    if (FUNCTIONS.has(t)) {
      take();
      const name = { arcsin: "asin", arccos: "acos", arctan: "atan" }[t] || t;
      return call(name, group());
    }
    if (t === "pi" || t === "e") { take(); return { type: "constant", name: t }; }
    if (isSymbol(t)) {
      take();
      if (peek() === "(" || peek() === "'") unsupported("unbound_function_notation");
      return { type: "variable", name: t };
    }
    unsupported("unsupported_expression");
  }
  function unary() {
    if (++depth > LIMITS.depth) unsupported("depth_resource_limit");
    let node;
    if (["+", "-"].includes(peek())) {
      const op = take(); node = unary(); if (op === "-") node = binary("*", num(-1), node);
    } else {
      node = primary();
      if (peek() === "^") {
        take();
        let exponent;
        if (!texScripts) exponent = unary();
        else if (peek() === "{") exponent = group();
        else if (peek()?.number?.length === 1 || isSymbol(peek())) exponent = primary();
        else unsupported("tex_exponent_requires_braces");
        node = binary("^", node, exponent);
      }
    }
    depth--; return node;
  }
  function startsPrimary(t) { return Boolean(t?.number || isSymbol(t) || FUNCTIONS.has(t) || ["(", "{", "frac", "pi", "boxed"].includes(t)); }
  function product() {
    let node = unary();
    while (true) {
      if (["*", "/"].includes(peek())) { const op = take(); node = binary(op, node, unary()); }
      else if (startsPrimary(peek()) && !(peek() === "d" && isSymbol(tokens[i + 1]))) node = binary("*", node, unary());
      else break;
    }
    return node;
  }
  function expression() {
    let node = product();
    while (["+", "-"].includes(peek())) { const op = take(); node = binary(op, node, product()); }
    return node;
  }
  function calculation() {
    if (isSymbol(peek()) && (tokens[i + 1] === "'" || (tokens[i + 1] === "(" && isSymbol(tokens[i + 2]) && tokens[i + 3] === ")" && tokens[i + 4] === "="))) {
      const name = take(); const derivative = peek() === "'";
      if (derivative) take("'");
      take("("); const variable = take(); take(")");
      if (!isSymbol(variable) || variable === "e") unsupported("unsupported_function_variable");
      return { kind: derivative ? "named_derivative" : "function_definition", name, variable };
    }
    if (peek() === "int") {
      take(); let lower = null; let upper = null;
      for (let n = 0; n < 2 && ["_", "^"].includes(peek()); n++) {
        const marker = take();
        if (texScripts && peek() !== "{" && peek()?.number?.length !== 1 && !isSymbol(peek())) unsupported("tex_bound_requires_braces");
        const bound = ["{", "("].includes(peek()) ? group() : primary();
        if (marker === "_") { if (lower) unsupported("duplicate_bound"); lower = bound; }
        else { if (upper) unsupported("duplicate_bound"); upper = bound; }
      }
      if (Boolean(lower) !== Boolean(upper)) unsupported("missing_integral_bound");
      const integrand = expression();
      let variable = take();
      if (variable === "d") variable = take();
      else if (typeof variable === "string" && /^d[A-Za-z]$/u.test(variable)) variable = variable[1];
      else unsupported("missing_differential");
      if (!isSymbol(variable) || variable === "e") unsupported("unsupported_variable");
      return { kind: lower ? "definite_integral" : "antiderivative", integrand, variable, lower, upper };
    }
    if (tokens[i] === "frac" && tokens[i + 1] === "{" && tokens[i + 2] === "d" && tokens[i + 3] === "}") {
      take("frac"); take("{"); take("d"); take("}"); take("{");
      let differential = take();
      if (differential === "d") differential = `d${take()}`;
      take("}");
      if (typeof differential !== "string" || !/^d[A-Za-z]$/u.test(differential)) unsupported("unsupported_derivative");
      return { kind: "derivative", variable: differential[1], expression: expression() };
    }
    return { kind: "expression", expression: expression() };
  }
  return { expression, calculation, peek, take, done: () => i === tokens.length };
}

export function parseExpression(source) {
  const p = parser(source); const ast = p.expression();
  if (!p.done()) unsupported("trailing_notation"); return ast;
}
export function parseStatement(source) {
  // Solution fields are TeX. A multi-digit or signed unbraced exponent does not
  // have ordinary infix meaning in TeX; do not silently reinterpret its rendering.
  const p = parser(source, { texScripts: true }); const left = p.calculation();
  if (p.done()) return left;
  p.take("="); const rhs = p.calculation();
  if (!p.done()) unsupported("multiple_or_ambiguous_relations");
  if (rhs.kind !== "expression") {
    if (left.kind === "expression" && left.expression.type === "variable" && ["antiderivative", "definite_integral"].includes(rhs.kind)) {
      return { kind: "calculation_assignment", name: left.expression.name, calculation: rhs };
    }
    unsupported("unsupported_calculation_relation");
  }
  const right = rhs.expression;
  return left.kind === "expression" ? { kind: "equality", left: left.expression, right } : { ...left, right };
}
export function variables(ast, result = new Set()) {
  if (ast.type === "variable") result.add(ast.name);
  if (ast.type === "binary") { variables(ast.left, result); variables(ast.right, result); }
  if (ast.type === "call") variables(ast.argument, result);
  return result;
}
export function format(ast) {
  if (ast.type === "number") return qText(ast.value);
  if (["variable", "constant"].includes(ast.type)) return ast.name;
  if (ast.type === "call") return `${ast.name}(${format(ast.argument)})`;
  return `(${format(ast.left)}${ast.op}${format(ast.right)})`;
}
export function substitute(ast, name, value) {
  if (ast.type === "variable" && ast.name === name) return value;
  if (ast.type === "binary") return binary(ast.op, substitute(ast.left, name, value), substitute(ast.right, name, value));
  if (ast.type === "call") return call(ast.name, substitute(ast.argument, name, value));
  return ast;
}

export function exactValue(ast) {
  if (ast.type === "number") return ast.value;
  if (ast.type !== "binary") return null;
  const a = exactValue(ast.left); const b = exactValue(ast.right);
  if (!a || !b) return null;
  if (ast.op === "+") return addQ(a, b);
  if (ast.op === "-") return addQ(a, negQ(b));
  if (ast.op === "*") return mulQ(a, b);
  if (ast.op === "/") return divQ(a, b);
  if (ast.op === "^" && b.d === 1n && b.n >= -12n && b.n <= 12n) {
    if (!a.n && b.n <= 0n) unsupported("undefined_power");
    const n = b.n < 0n ? -b.n : b.n;
    return b.n < 0n ? rational(a.d ** n, a.n ** n) : rational(a.n ** n, a.d ** n);
  }
  return null;
}

// Formal rational-function arithmetic with opaque function atoms. Callers must
// discharge domain obligations on the ORIGINAL AST before using a zero result.
export function canonicalDifference(left, right) {
  let operations = 0;
  // Share opaque atom IDs across both expressions. Embedding the recursively
  // serialized atom in every monomial makes nested functions grow exponentially
  // through JSON escaping, even when all algebra operation limits are respected.
  const atomIds = new Map();
  const tick = () => { if (++operations > LIMITS.operations) unsupported("algebra_resource_limit"); };
  const constant = (q) => new Map(q.n ? [["[]", q]] : []);
  function sum(a, b, sign = 1n) {
    const out = new Map(a);
    for (const [key, q] of b) { tick(); const next = addQ(out.get(key) || rational(0n), mulQ(q, rational(sign))); if (next.n) out.set(key, next); else out.delete(key); }
    if (out.size > LIMITS.terms) unsupported("term_resource_limit"); return out;
  }
  function multiply(a, b) {
    let out = new Map();
    for (const [ka, qa] of a) for (const [kb, qb] of b) {
      tick(); const atoms = [...JSON.parse(ka), ...JSON.parse(kb)].sort();
      if (atoms.length > 48) unsupported("degree_resource_limit");
      out = sum(out, new Map([[JSON.stringify(atoms), mulQ(qa, qb)]]));
    }
    return out;
  }
  const one = () => constant(rational(1n));
  const encode = (p) => [...p].sort(([a], [b]) => a.localeCompare(b)).map(([key, q]) => [key, qText(q)]);
  function visit(ast, depth = 0) {
    tick(); if (depth > LIMITS.depth) unsupported("depth_resource_limit");
    if (ast.type === "number") return { n: constant(ast.value), d: one() };
    if (ast.type === "call" || ast.type === "constant" || ast.type === "variable") {
      const arg = ast.type === "call" ? visit(ast.argument, depth + 1) : null;
      const atom = JSON.stringify([ast.type, ast.name, arg ? [encode(arg.n), encode(arg.d)] : null]);
      if (!atomIds.has(atom)) atomIds.set(atom, atomIds.size);
      return { n: new Map([[JSON.stringify([atomIds.get(atom)]), rational(1n)]]), d: one() };
    }
    const a = visit(ast.left, depth + 1);
    if (ast.op === "^") {
      const exponent = exactValue(ast.right);
      if (!exponent || exponent.d !== 1n || exponent.n < -12n || exponent.n > 12n) unsupported("unsupported_symbolic_power");
      let n = one(); let d = one();
      for (let k = 0; k < Math.abs(Number(exponent.n)); k++) { n = multiply(n, a.n); d = multiply(d, a.d); }
      return exponent.n < 0n ? { n: d, d: n } : { n, d };
    }
    const b = visit(ast.right, depth + 1);
    if (["+", "-"].includes(ast.op)) return { n: sum(multiply(a.n, b.d), multiply(b.n, a.d), ast.op === "+" ? 1n : -1n), d: multiply(a.d, b.d) };
    if (ast.op === "*") return { n: multiply(a.n, b.n), d: multiply(a.d, b.d) };
    return { n: multiply(a.n, b.d), d: multiply(a.d, b.n) };
  }
  const a = visit(left); const b = visit(right);
  return sum(multiply(a.n, b.d), multiply(b.n, a.d), -1n).size === 0;
}

export function differentiate(ast, variable, budget = { nodes: 0 }) {
  if (++budget.nodes > 800) unsupported("derivative_resource_limit");
  const d = (node) => differentiate(node, variable, budget);
  const mul = (a, b) => binary("*", a, b);
  const pow = (a, b) => binary("^", a, b);
  if (ast.type === "number" || ast.type === "constant") return num(0);
  if (ast.type === "variable") return num(ast.name === variable ? 1 : 0);
  if (ast.type === "binary") {
    const { left: a, right: b, op } = ast;
    if (["+", "-"].includes(op)) return binary(op, d(a), d(b));
    if (op === "*") return binary("+", mul(d(a), b), mul(a, d(b)));
    if (op === "/") return binary("/", binary("-", mul(d(a), b), mul(a, d(b))), pow(b, num(2)));
    const n = exactValue(b);
    if (!n || n.d !== 1n || n.n < -12n || n.n > 12n) unsupported("unsupported_derivative_power");
    if (n.n === 0n) return num(0);
    if (n.n === 1n) return d(a);
    return mul(mul(num(n), pow(a, num(addQ(n, rational(-1n))))), d(a));
  }
  const a = ast.argument;
  const outer = {
    sin: () => call("cos", a), cos: () => mul(num(-1), call("sin", a)),
    exp: () => call("exp", a), ln: () => binary("/", num(1), a),
    tan: () => binary("/", num(1), pow(call("cos", a), num(2))),
    sqrt: () => binary("/", num(1), mul(num(2), call("sqrt", a))),
    atan: () => binary("/", num(1), binary("+", num(1), pow(a, num(2)))),
    asin: () => binary("/", num(1), call("sqrt", binary("-", num(1), pow(a, num(2))))),
    acos: () => binary("/", num(-1), call("sqrt", binary("-", num(1), pow(a, num(2))))),
  }[ast.name];
  if (!outer) unsupported("unsupported_derivative_function");
  return mul(outer(), d(a));
}
