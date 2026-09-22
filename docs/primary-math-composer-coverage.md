# Primary composer notation coverage audit

This inventory was organized by mathematical families and the requested disciplines, not by iterating the registry and assuming completeness. General composition (letters, numbers, nesting, indices, editable arrays, text and delimiters) covers arbitrary expressions; a catalog is not a finite enumeration of every mathematical formula. The raw source escape hatch remains necessary for specialist macros and custom LaTeX environments.

## Independent family inventory and comparison

| Required family / disciplines | Finding against the original 236-entry catalog | Implemented coverage / composition route |
| --- | --- | --- |
| Arithmetic and binary operators | Common arithmetic present; circled/boxed and composition operators missing | Standard arithmetic, composition, convolution, tensor/Hadamard products, circled/boxed operators |
| Relations, ordering and negation | Basic comparisons present; negated inequalities/divisibility and order relations missing | Negated order, divisibility, equivalence, approximation, semidefinite ordering, proper subset |
| Greek alphabets and variants | Lowercase, variants and distinct uppercase Greek present | Retained; Latin-shaped uppercase Greek is typed using its ordinary Latin-shaped letter |
| Elementary and hyperbolic functions | No dedicated ordinary function family | Trig, inverse trig, hyperbolic and inverse hyperbolic, exponential, log, arbitrary log base |
| Special functions used in graduate STEM | Missing discoverable examples | Gamma, beta, error and Bessel functions; editable function argument/index composition |
| Fractions, powers, roots and combined indices | Existing templates inserted literal squares into text | Selection-aware editable fraction, root, nth root, exponent, subscript and combined indices |
| Derivatives and ODE/PDE notation | Basic derivative/partial templates present; higher/mixed/boundary forms missing | Higher/mixed partial, time-dot accents, material/normal/covariant derivatives, initial/boundary conditions |
| Integral families | Basic integrals present; advanced editable structures incomplete | Definite/indefinite, double/triple, line, contour, surface, closed volume, iterated and stochastic integrals |
| Large operators and limits | Sum/product/limit present; additional families and convergence incomplete | Sums/products/coproducts, union/intersection, wedge/vee, tensor/direct sum, limsup/liminf |
| Linear algebra and numerical linear algebra | Basic matrix/operator examples present; standard operator/norm/decomposition family incomplete | Kernel/image/span, trace/rank/dimension, adjoint/pseudoinverse, singular values, spectral radius, condition number and common norms |
| Matrices, determinants, vectors and systems | Fixed 2×2 examples and basic cases/aligned templates present | Editable 2×2/3×3, bracket/augmented matrices, column vectors, determinants, cases/systems/aligned equations; row/column controls |
| Sets, number systems and logic | Basic sets/logic/number systems present; refinements missing | All retained; finite fields, quaternions, disjoint union, proper/negated subsets, uniqueness, proof/entailment/top/bottom |
| Abstract algebra | Sparse discoverable operators | Normal subgroup, quotient group, Hom/Aut, direct/tensor products; arbitrary group/ring notation via editable indices and operators |
| Combinatorics and discrete mathematics | Binomial template present; factorial variants/graph/modular notation missing | Binomial/multinomial, rising/falling factorial, graph/degree, congruence modulo |
| Real/complex analysis and topology | Number systems and a few accents only | Real/imaginary part, argument/conjugate/residue, big/little O, essential supremum, closure/interior/boundary, Lp/Ck/Sobolev spaces |
| Mappings and convergence | Basic arrows only | Labelled/isomorphism arrows, weak/weak-star/uniform, probability/distribution/almost-sure convergence |
| Geometry, differential geometry and forms | Elementary angles present; tensor geometry/forms missing | Angles, metric, Christoffel/Riemann/Ricci, covariant/Lie/exterior derivatives, wedge/Hodge star |
| Vector calculus | Gradient/divergence/curl/Laplacian present | Retained, with editable vector fields, indices, flux/line/surface integrals and boundary derivative structures |
| Numerical analysis | Residual/approximation only | Machine epsilon, absolute/relative/truncation errors, forward/backward/central difference and indexed iterates |
| Optimization and operations research | Basic argmin/max/Hessian/Lagrangian present | Editable constrained optimization, subgradient, proximal/conjugate/convex hull, semidefinite order, Hessian/Jacobian; indexed sums, vectors and constraints compose LP/QP/KKT notation |
| Probability/statistics | Basic E/Var/Cov/P and normal distribution present; conditional/distribution/statistical families incomplete | Conditional expectation, indicators, moments, density/CDF/MGF/characteristic functions, sample estimates, Fisher information and normal/uniform/Bernoulli/binomial/Poisson/exponential/gamma/beta/t/chi-square/F/geometric families |
| Stochastic processes | Ordinary probability notation only | Brownian/Wiener, filtration, quadratic variation, Markov transition, stochastic differential and Ito integral templates |
| Machine learning mathematics | Generic gradient/optimization only | Softmax, sigmoid, ReLU, cross-entropy plus matrix, probability, differentiation and optimization structures |
| Information theory | Missing explicit family | Entropy, conditional entropy, mutual information, KL divergence and cross entropy |
| Signal processing and control | Missing explicit family | Fourier/inverse Fourier/Laplace/inverse Laplace/Z/DFT, Fourier series, convolution/correlation, Dirac/Heaviside/sinc, state-space/transfer/frequency response, controllability/observability |
| Classical mechanics | A few shared physics operators present | Momentum/angular momentum/torque, Hamiltonian/Lagrangian/Poisson bracket, derivatives and indexed vectors |
| Electromagnetism | Shared calculus operators only | E/B/D/H, permittivity/permeability; differential/integral/vector structures compose Maxwell notation |
| Quantum mechanics | Bra/ket/basic commutators present | Matrix elements, outer/tensor states, density operator, adjoints, hbar, commutator/anticommutator and editable bra/operator/ket |
| Thermodynamics/statistical mechanics | No explicit family | Partition function, entropy/free energies/Boltzmann constant; partials/subscripts compose thermodynamic potentials and constraints |
| Fluid/continuum/engineering mathematics | Shared tensors/vectors only | Stress/strain, material derivative, Reynolds number, tensors, PDE/boundary and vector differential notation |
| Tensor/index structures | Two basic templates present | Einstein contraction, mixed variance indices with spacing, covariant derivatives and geometry tensors |
| Accents, delimiters and ellipses | Basic family present; wide/bold/brace forms incomplete | Hat/bar/dots/arrows/tilde, bold vectors/symbols, over/underbrace, floor/ceiling/norm/absolute/set-builder, horizontal/vertical/diagonal ellipses |

## What was discovered and added

First comparison: 213 additions across ordinary functions, relations, analysis, numerical methods, transforms/control, statistics/information theory, geometry/tensors, physics and advanced structures. The next independent pass identified a further 74 omissions: 60 symbol/operator/notation entries and 14 editable structures. These include inverse/hyperbolic/special functions, missing distribution families, stochastic processes, analysis spaces, abstract algebra, ML notation, pseudoinverse/SVD, ellipses, augmented matrices, mixed tensor indices, quantum matrix elements, boundary conditions and Fourier series.

All original catalog IDs remain available. Existing insertion definitions stay valid legacy LaTeX with their original square markers, while `editorInsertion` carries MathLive's selection (`#@`) and placeholder (`#?`) instructions. `displayLatex` is rendered by KaTeX. Categories, aliases, human-name search, recent IDs and subcategories reuse the existing registry infrastructure.

Final inventory: **523 entries: 461 symbols/operators/notation examples and 62 editable structures; 22 categories and 100 category/subcategory pairs.** These are registry record counts, not a claim of 461 distinct Unicode glyphs. Some standard notation is naturally available under more than one discipline.

Compatibility findings: KaTeX's unsupported `\\nsubset` form was replaced with `\\not\\subset`; MathLive does not accept `\\idotsint`, so the iterated-integral example uses supported integral and dots commands. Empty textual squares were replaced by native editor placeholders. A missing human alias for `perp` was found during search verification and added.

The repeated comparison above accounts for every requested discipline through dedicated notation and reusable composition primitives. This supports broad standard Master's-level composition; it does not claim support for arbitrary TeX packages/macros in visual mode. All 523 display definitions and insertion definitions are checked in both parsers, and all 523 insertions are also checked in an actual browser mathfield. Separate tests exercise keyboard editing, arrays and seven independently authored graduate expressions; parser acceptance alone is not treated as evidence of editing behavior or mathematical correctness.

## Added catalog records

These 287 IDs are additions to the original 211 symbol/notation entries and 25 structures. Existing IDs were preserved.

- **arithmetic**: `ast`, `star`, `circ`, `bullet`, `diamond`, `ominus`, `oslash`, `odot`, `boxplus`, `boxminus`, `boxtimes`, `boxdot`, `wreath`, `amalgamation`.

- **relations**: `notLess`, `notGreater`, `notLessEqual`, `notGreaterEqual`, `precedesEqual`, `succeedsEqual`, `notParallel`, `divides`, `notDivides`, `doteq`, `bowtie`, `notEquivalent`, `notApproximate`, `properSubset`.

- **functions**: `sin`, `cos`, `tan`, `cot`, `sec`, `csc`, `arcsin`, `arccos`, `arctan`, `sinh`, `cosh`, `tanh`, `coth`, `exponential`, `naturalLog`, `logarithm`, `gcd`, `lcm`, `signum`, `sech`, `csch`, `arccot`, `arcsec`, `arccsc`, `arsinh`, `arcosh`, `artanh`, `gammaFunction`, `betaFunction`, `errorFunction`, `besselFunction`.

- **calculus**: `idotsint`, `oiiint`, `prime`, `doublePrime`, `dalembertian`, `bigWedge`, `bigVee`.

- **analysis**: `limitSuperior`, `limitInferior`, `essentialSupremum`, `bigO`, `littleO`, `weakConvergence`, `weakStarConvergence`, `uniformConvergence`, `realPart`, `imaginaryPart`, `complexArgument`, `complexConjugate`, `residue`, `imaginaryUnit`, `lpSpace`, `sobolevSpace`, `continuousSpace`, `closure`, `interior`, `boundary`.

- **sets**: `notSubsetEqual`, `notSupersetEqual`, `bigUnion`, `bigIntersection`, `disjointUnion`, `quaternions`, `finiteField`, `normalSubgroup`, `quotientGroup`, `homomorphism`, `automorphism`.

- **logic**: `proves`, `dashv`, `top`, `bottom`, `uniqueExists`.

- **linearAlgebra**: `dagger`, `diagonalOperator`, `dimension`, `kernel`, `image`, `span`, `orthogonalComplement`, `directSum`, `bigDirectSum`, `hadamardProduct`, `oneNorm`, `twoNorm`, `infinityNorm`, `frobeniusNorm`, `spectralRadius`, `pseudoinverse`, `singularValues`, `bigTensorProduct`.

- **discrete**: `fallingFactorial`, `risingFactorial`, `graphDegree`, `graph`, `congruentModulo`.

- **probability**: `conditionalExpectation`, `indicator`, `sampleMean`, `sampleVariance`, `standardDeviation`, `standardError`, `normalDistribution`, `uniformDistribution`, `bernoulliDistribution`, `binomialDistribution`, `poissonDistribution`, `exponentialDistribution`, `convergenceProbability`, `convergenceDistribution`, `convergenceAlmostSure`, `entropy`, `conditionalEntropy`, `mutualInformation`, `klDivergence`, `gammaDistribution`, `betaDistribution`, `studentT`, `chiSquared`, `fDistribution`, `geometricDistribution`, `cdf`, `pdf`, `mgf`, `characteristicFunction`, `fisherInformation`, `brownianMotion`, `filtration`, `quadraticVariation`, `transitionProbability`.

- **optimization**: `convexHull`, `subgradient`, `proximalOperator`, `convexConjugate`, `positiveSemidefinite`, `negativeSemidefinite`, `positiveDefinite`, `softmax`, `sigmoid`, `relu`, `crossEntropy`, `subjectTo`.

- **numerical**: `machineEpsilon`, `absoluteError`, `relativeError`, `conditionNumber`, `forwardDifference`, `backwardDifference`, `centralDifference`, `truncationError`, `iteration`.

- **geometry**: `measuredAngle`, `sphericalAngle`, `squareShape`.

- **arrows**: `longLeftArrow`, `longLeftRightArrow`, `upDownArrow`, `rightHarpoonUp`, `rightLeftHarpoons`, `northEastArrow`, `southEastArrow`, `isomorphism`.

- **transforms**: `fourierTransform`, `inverseFourierTransform`, `laplaceTransform`, `inverseLaplaceTransform`, `zTransform`, `convolution`, `crossCorrelation`, `diracDelta`, `heaviside`, `sinc`, `transferFunction`, `stateSpace`, `controllability`, `observability`, `discreteFourier`, `frequencyResponse`.

- **physics**: `outerProductQuantum`, `poissonBracket`, `hamiltonianPhysics`, `momentum`, `angularMomentum`, `torque`, `electricField`, `magneticField`, `electricDisplacement`, `magneticIntensity`, `vacuumPermittivity`, `vacuumPermeability`, `partitionFunction`, `thermodynamicEntropy`, `helmholtzFreeEnergy`, `gibbsFreeEnergy`, `stressTensor`, `strainTensor`, `materialDerivative`, `reynoldsNumber`, `boltzmannConstant`, `densityOperator`, `tensorState`.

- **tensors**: `einsteinSum`, `covariantDerivative`, `christoffel`, `riemannTensor`, `ricciTensor`, `metricTensor`, `lieDerivative`, `wedgeProduct`, `exteriorDerivative`, `hodgeStar`.

- **accents**: `wideTilde`, `tripleDot`, `boldVector`, `boldSymbol`, `overleftarrow`, `overbrace`, `underbrace`.

- **delimiters**: `horizontalDots`, `verticalDots`, `diagonalDots`.

- **structures**: `higherDerivative`, `mixedPartialDerivative`, `tripleIntegralStructure`, `lineIntegral`, `contourIntegralStructure`, `surfaceIntegralStructure`, `evaluation`, `setBuilder`, `innerProductStructure`, `matrix3x3`, `expectationStructure`, `conditionalExpectationStructure`, `varianceStructure`, `argminStructure`, `argmaxStructure`, `constrainedOptimization`, `jacobianStructure`, `hessianStructure`, `fourierTransformStructure`, `laplaceTransformStructure`, `outerProductStructure`, `commutatorStructure`, `covariantDerivativeStructure`, `stochasticDifferential`, `itoIntegral`, `bracketMatrix`, `columnVector`, `augmentedMatrix`, `tensorMixedIndices`, `matrixElement`, `logBase`, `multinomial`, `normalDerivative`, `initialCondition`, `fourierSeries`, `alignedSystem`, `annotatedArrow`.
