export const variationalFunctionalLatex = String.raw`J[u]=\int_\Omega\left[\frac{1}{2}|\nabla u|^2+\frac{\alpha}{4}|\nabla u|^4+\frac{\beta}{2}u^2-\frac{\lambda}{p}|u|^p\right]\,dx,\text{ where }\alpha>0,\beta>0,\lambda>0,2<p<6`;

export const fractionCases = [
  { name: "simple fraction", latex: String.raw`\frac{1}{2}`, numerator: "1", denominator: "2" },
  { name: "alpha over four", latex: String.raw`\frac{\alpha}{4}`, numerator: String.raw`\alpha`, denominator: "4" },
  { name: "beta over two", latex: String.raw`\frac{\beta}{2}`, numerator: String.raw`\beta`, denominator: "2" },
  { name: "lambda over p", latex: String.raw`\frac{\lambda}{p}`, numerator: String.raw`\lambda`, denominator: "p" },
  { name: "nested grouped fraction", latex: String.raw`\frac{1+\frac{x}{2}}{(a+b)^2}`, numerator: String.raw`1+\frac{x}{2}`, denominator: String.raw`(a+b)^2` },
];
