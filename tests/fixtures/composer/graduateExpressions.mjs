// Independent mathematical examples, not generated from registry entries.
export const graduateExpressions = [
  ['nested calculus', String.raw`\int_0^1\frac{\partial}{\partial x}\left(\int_0^x e^{-t^2}\,dt\right)\,dx`],
  ['matrix', String.raw`A=\begin{bmatrix}1&2\\3&4\end{bmatrix},\quad A^{-1}=\frac{1}{-2}\begin{bmatrix}4&-2\\-3&1\end{bmatrix}`],
  ['PDE', String.raw`\frac{\partial u}{\partial t}=\alpha\nabla^2u,\quad u(0,t)=0,\quad u(x,0)=\sin x`],
  ['optimization', String.raw`\min_{x\in\mathbb{R}^n}\frac{1}{2}\lVert Ax-b\rVert^2+\lambda\lVert x\rVert_1`],
  ['probability', String.raw`\mathbb{E}[X\mid Y=y]=\int_{-\infty}^{\infty}x f_{X\mid Y}(x\mid y)\,dx`],
  ['quantum', String.raw`i\hbar\frac{\partial}{\partial t}|\psi\rangle=\hat{H}|\psi\rangle,\quad\langle\phi|\psi\rangle=0`],
  ['tensor', String.raw`\nabla_\mu V^\nu=\partial_\mu V^\nu+\Gamma^\nu_{\mu\rho}V^\rho`],
];
