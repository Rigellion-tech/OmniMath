export const semanticRenderingCorpus = [
  ["shorthand-fraction", String.raw`\frac14`],
  ["command-arguments", String.raw`\frac\alpha\beta`],
  ["shorthand-radical", String.raw`\sqrt x`],
  ["optional-shorthand-radical", String.raw`\sqrt[3]x`],
  ["nested-fractions", String.raw`\frac{1+\frac{x}{1+\frac yz}}{\frac{a+b}{c+d}}`],
  ["nested-radicals", String.raw`\sqrt[n+1]{\frac{x^2+\sqrt[3]{y_1}}{1+\sqrt{z}}}`],
  ["scripts", String.raw`x^{y_{z^2}}+a_i^2+b^2_j`],
  ["scripted-functions", String.raw`\sin^2\theta+\log_2 x+f_i^{-1}(x)`],
  ["delimiters", String.raw`\left\lVert\frac{x+y}{z}\right\rVert+\left(x\middle|y\right)`],
  ["accents", String.raw`\hat{x}+\widehat{xy}+\vec{v}+\overline{a+b}+\underbrace{x+x}_{2x}`],
  ["binomial", String.raw`\binom{n}{k}+\overset{!}{=}\underset{x}{\operatorname{argmax}}f(x)`],
  ["sum-product-limit", String.raw`\lim_{n\to\infty}\sum_{i=1}^n\prod_{j=1}^i\frac1{j+1}`],
  ["explicit-limits", String.raw`\sum\limits_{i=1}^n i+\int\nolimits_0^1 x\,dx`],
  ["substack", String.raw`\lim_{\substack{x\to0\\x>0}}\frac{\sin x}{x}`],
  ["matrix", String.raw`\begin{pmatrix}\frac{a_1}{b^2}&x^{y_z}\\\sqrt{q}&r\end{pmatrix}`],
  ["array-options", String.raw`\begin{array}{c|r}x&y\\[2pt]z&w\end{array}`],
  ["cases", String.raw`f(x)=\begin{cases}x^2&\text{if }x>0\\-x&\text{otherwise}\end{cases}`],
  ["aligned", String.raw`\begin{aligned}a&=b+c\\&=\frac de\end{aligned}`],
  ["nested-environments", String.raw`\begin{pmatrix}\begin{cases}x&x>0\\0&x\le0\end{cases}&\begin{matrix}a&b\\c&d\end{matrix}\end{pmatrix}`],
  ["equality-chain", String.raw`x+x=2x=\frac{4x}{2}`],
  ["intervals-unary", String.raw`-x\in(-\infty,0]\cup[1,\infty)`],
  ["repeated", String.raw`x+\frac{x+x}{x}+\sqrt{x}+x^x+x_x`],
  ["text-ligatures", String.raw`\text{office if ffi -- }x+\operatorname{erf}(x)`],
  ["math-glyph-runs", String.raw`\pi/2+2\Gamma(x)+\mathrm{office}+\mathit{ffi}`],
  ["escaped", String.raw`\{x\}\quad\%+\$+\_+\&+\#`],
  ["scope", String.raw`\color{red}x+y`],
  ["style-scope", String.raw`\displaystyle\frac{x}{y}+\scriptstyle a+b`],
  ["dimension-arguments", String.raw`\rule[2pt]{1em}{3pt}+x`],
  ["sized-delimiters", String.raw`\Bigl(\frac xy\Bigr)`],
  ["infix-fraction", String.raw`a\over b`],
  ["macro-definition", String.raw`\def\foo#1{#1^2}\foo x+\foo y`],
  ["duplicate-expansion", String.raw`\def\twice#1{#1+#1}\twice{x}`],
  ["style-branches", String.raw`\mathchoice{a}{b}{c}{d}+x`],
  ["comment", "x% ignore y+z\n+x"],
  ["optional-arrow", String.raw`\xrightarrow[n+1]{x^2}y`],
  ["long-scroll", Array.from({ length: 24 }, (_, i) => String.raw`\frac{x_{${i}}+\sqrt{x}}{1+x^2}`).join("+")],
].map(([name, latex]) => ({ name, latex }));

export const mastersNotationCorpus = [
  ["variational-calculus", String.raw`J'+J''+DJ+D^2J+\delta J+\delta^2J+u_*+u^*+\lambda_1+\lambda_{\min}`],
  ["functional-analysis", String.raw`H_0^1+W^{1,p}+X^*+T^*+A^{-1}+\lVert u\rVert_{H^1}+\left\langle Au,v\right\rangle`],
  ["pde", String.raw`\partial_\nu u+\Delta u+\nabla\cdot F+\nabla\times u+u_t+u_{tt}+D^\alpha u+(-\Delta)^s`],
  ["linear-algebra-spectral", String.raw`\lambda_i(A)+\sigma(A)+A^T+A^*+A^{-1}+\ker A+\operatorname{im}A+\operatorname{tr}A+\det A`],
  ["probability-statistics", String.raw`X_n+X^{(k)}+E[X]+\operatorname{Var}(X)+\hat\theta+\theta_0+\mu_i+\sigma^2`],
  ["tensor-physics", String.raw`F^{-T}+C_{ij}+T^{\mu\nu}+\varepsilon_{ijk}+\partial_\mu+A_\mu^a`],
  ["accents-derivatives", String.raw`\hat u+\bar u+\tilde u+\dot u+\ddot u+u'+u''+u'''+u^{(n)}+u_i'+u_*''+u_i^{*}`],
  ["large-operators-bounds", String.raw`\inf_{v\in X}f(v)+\sup_{u\ne0}g(u)+\lim_{n\to\infty}a_n+\sum_{i=1}^n x_i+\prod_{k=1}^m y_k+\int_0^1\frac{u_*''}{1+u^2}\,du`],
  ["production-decorated-context", String.raw`\lambda_1(L_*)=\inf_{v\in X,\,v\ne0}\frac{J''[u_*](v,v)}{\lVert v\rVert^2}`],
].map(([name, latex]) => ({ name, latex }));

const GENERATED_BASES = ["x", "u", "v", "J", "L", "A", "T", "F", "\\lambda", "\\beta", "\\mu", "\\phi", "\\psi", "\\theta", "\\xi", "\\alpha"];
const GENERATED_DECORATIONS = ["_1", "_2", "_i", "_j", "_*", "_{ij}", "_{\\min}", "_{\\max}", "^2", "^*", "^{-1}", "^T", "^{(k)}", "'", "''", "'''"];
const GENERATED_ACCENTS = ["hat", "bar", "tilde", "dot", "ddot"];

// Deterministic valid compositions. The pairwise cases deliberately exercise
// the script-then-prime boundary that previously split a single atom.
export const generatedDecoratedNotationCorpus = [
  ...GENERATED_BASES.flatMap((base) => GENERATED_DECORATIONS.map((decoration) => `${base}${decoration}`)),
  ...GENERATED_BASES.flatMap((base) => GENERATED_ACCENTS.map((accent) => `\\${accent}{${base}}`)),
  String.raw`\beta_1`, String.raw`\lambda_*`, String.raw`\mu_i'`, String.raw`\psi_*''`,
  String.raw`J_i''`, String.raw`L_*'`, String.raw`A_i^{-1}`, String.raw`A_*^T`,
  String.raw`T_\mu^{*}`, String.raw`u_*''`, String.raw`\phi_{ij}^{-1}`,
  String.raw`\hat{u}_i`, String.raw`\bar{\psi}^{*}`, String.raw`\tilde{\phi}_k`,
  String.raw`\dot{u}_i`, String.raw`\ddot{u}_*`,
].filter((latex, index, all) => all.indexOf(latex) === index)
  .map((latex, index) => ({ name: `generated-decorated-${index + 1}`, latex }));
