import { looksLikeBrokenMathLabel } from "./presentationLabels.js";

const ROLE_EXPLANATIONS = {
  variable: {
    short: "Variable",
    medium: "This variable represents a quantity that can change or be solved for.",
    deep: "A variable is a named mathematical quantity. Its meaning comes from the equation, term, or operation around it.",
  },
  coefficient: {
    short: "Coefficient",
    medium: "This coefficient multiplies the factor next to it.",
    deep: "A coefficient scales a variable, function, term, or integral. Changing it changes the size of that whole factor.",
  },
  constant: {
    short: "Constant",
    medium: "This is a fixed value in the expression.",
    deep: "A constant contributes a known value rather than an unknown or changing quantity.",
  },
  imaginaryUnit: {
    short: "Imaginary unit",
    medium: "The imaginary unit satisfies i^2=-1 and marks the non-real part of a complex value.",
    deep: "The imaginary unit extends real-number arithmetic to complex numbers. A factor next to i scales the imaginary component.",
  },
  operator: {
    short: "Operator",
    medium: "This operator connects neighboring mathematical pieces.",
    deep: "Operators describe how adjacent expressions are combined or compared.",
  },
  root: {
    short: "Radical expression",
    medium: "This radical represents a root applied to its radicand.",
    deep: "A radical expression applies the root operation to the expression under the radical bar.",
  },
  radical: {
    short: "Radical sign",
    medium: "The radical sign marks that the expression under the bar is inside a root.",
    deep: "The radical sign groups the radicand and indicates a root operation, usually a square root when no index is shown.",
  },
  radicand: {
    short: "Radicand",
    medium: "The radicand is the expression inside the radical.",
    deep: "The root operation is applied to the radicand, so this inner value determines the radical's value.",
  },
  equality: {
    short: "Equality",
    medium: "The equals sign says the expressions on both sides have the same value.",
    deep: "An equality relation lets us transform one side while preserving the value of the other side.",
  },
  term: {
    short: "Term",
    medium: "This term is one additive piece of the expression.",
    deep: "Terms are the chunks separated by plus or minus signs. Each term contributes to the whole expression.",
  },
  factor: {
    short: "Factor",
    medium: "This factor is multiplied as part of a product.",
    deep: "A factor is one component in a multiplication. Products are understood by how their factors combine.",
  },
  numerator: {
    short: "Numerator",
    medium: "The numerator is the top part of the fraction.",
    deep: "The numerator is divided by the denominator and determines the amount being split.",
  },
  denominator: {
    short: "Denominator",
    medium: "The denominator is the bottom part of the fraction.",
    deep: "The denominator tells what the numerator is divided by and cannot be zero.",
  },
  exponent: {
    short: "Exponent",
    medium: "The exponent tells what power is applied to the base.",
    deep: "An exponent changes the degree, repeated multiplication, or growth behavior of the base.",
  },
  base: {
    short: "Base",
    medium: "The base is the expression being raised to a power.",
    deep: "The exponent acts on this base, so the base determines what quantity is powered.",
  },
  argument: {
    short: "Function argument",
    medium: "This is the input to the function.",
    deep: "A function argument is the value or expression the function is evaluated on.",
  },
  function: {
    short: "Function",
    medium: "This function applies a rule to its argument.",
    deep: "Function notation means an input expression is being transformed by a named rule.",
  },
  functionName: {
    short: "Function name",
    medium: "This names the function being applied.",
    deep: "The function name identifies which rule acts on the following argument.",
  },
  functionCall: {
    short: "Function call",
    medium: "This applies a named function to its argument.",
    deep: "A function call combines the function name with one or more input arguments.",
  },
  integralSymbol: {
    short: "Integral symbol",
    medium: "The integral symbol marks accumulation over a domain or variable.",
    deep: "An integral combines infinitesimal contributions specified by the integrand and differential.",
  },
  lowerBound: {
    short: "Lower bound",
    medium: "This is the starting bound for the integral.",
    deep: "A lower bound sets where accumulation begins for the associated integration variable.",
  },
  upperBound: {
    short: "Upper bound",
    medium: "This is the ending bound for the integral.",
    deep: "An upper bound sets where accumulation stops for the associated integration variable.",
  },
  integrand: {
    short: "Integrand",
    medium: "The integrand is the expression being accumulated.",
    deep: "The integrand tells what quantity is added up across the bounds or domain of integration.",
  },
  differential: {
    short: "Differential",
    medium: "The differential identifies the integration variable.",
    deep: "The differential tells which variable changes infinitesimally and often fixes the order of integration.",
  },
  differentialOperator: {
    short: "Differential operator",
    medium: "This marks differentiation or an infinitesimal change.",
    deep: "The differential operator identifies the variable or quantity being differentiated or integrated.",
  },
  derivativeVariable: {
    short: "Derivative variable",
    medium: "This is the variable with respect to which differentiation occurs.",
    deep: "The derivative variable controls which input is changing while the derivative is measured.",
  },
  summationOperator: {
    short: "Summation symbol",
    medium: "The summation symbol means add the following terms over the given bounds.",
    deep: "A summation accumulates terms while an index runs through its allowed values.",
  },
  limitOperator: {
    short: "Limit operator",
    medium: "The limit operator asks what value an expression approaches.",
    deep: "A limit describes behavior as a variable approaches a specified value or direction.",
  },
  bound: {
    short: "Bound",
    medium: "This condition controls the variable range for the surrounding operator.",
    deep: "Bounds specify where an integral, summation, product, or limit is evaluated.",
  },
  matrixCell: {
    short: "Matrix cell",
    medium: "This is one entry in a matrix.",
    deep: "A matrix cell is positioned by its row and column and contributes one component of the matrix.",
  },
  leftSide: {
    short: "Left side",
    medium: "This is the left side of the equation.",
    deep: "The left side is one expression in the equality relation.",
  },
  rightSide: {
    short: "Right side",
    medium: "This is the right side of the equation.",
    deep: "The right side is the expression equal to the left side.",
  },
};

export function getLocalSemanticExplanation(node = {}) {
  const explanation = ROLE_EXPLANATIONS[node.role] || ROLE_EXPLANATIONS[node.type] || null;
  if (!explanation) return null;
  const latex = node.latex || node.display || node.text || "This expression";
  return {
    short: explanation.short,
    medium: `${latex}: ${explanation.medium}`,
    deep: `${latex}: ${explanation.deep}`,
  };
}

export function attachLocalSemanticExplanation(token = {}) {
  const explanation = getLocalSemanticExplanation(token);
  if (!explanation) return token;
  return {
    ...token,
    short: token.short || explanation.short,
    medium: token.medium || explanation.medium,
    deep: token.deep || explanation.deep,
  };
}

export function cleanSemanticTarget(target, targetById, fallbackTarget = null) {
  let current = target;
  while (current && looksLikeBrokenMathLabel(current.display || current.text || current.latex)) {
    current = current.parentId ? targetById?.get?.(current.parentId) : null;
  }
  return current || fallbackTarget || target;
}
